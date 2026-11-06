// Forward: the browser's way back to a login running on another machine.
//
// `aws sso login`, `gcloud auth login`, `codex login` and Claude Code's /login
// open a browser page that, once you have signed in, sends the browser to
// http://127.0.0.1:<port>/... where the command listens for the code. In a
// space on another machine (devbox) the command, and so its listener, is
// there, while the browser that opens the link is here: the callback lands on
// this computer's 127.0.0.1:<port>, where nothing answers.
//
// This mod watches remote terminals for such a URL (its `redirect_uri` names
// a loopback host and the port) and opens an SSH tunnel for that port to the
// machine (`ssh -L <port>:localhost:<port> <target>`, the target from
// `hc machine ls`), in a core terminal of its own that Herdr's screens don't
// show (labels `forward.port`, `forward.machine`, `forward.from`). The remote
// end watches the listener: the tunnel closes by itself once the login is
// done (nothing listens there any more), or after 15 minutes. A toast says
// when a port is forwarded; while any is, this floating block draws a pill
// per tunnel (× closes it). Quitting Herdr or switching layouts leaves a
// tunnel running: it ends with the login.
//
// What is read, and how often: the screen (`hc read`) of a remote terminal
// whose program looks like a login (aws, gcloud, az, gh, or a command line
// saying login, auth, sso, ...), once a second while it runs (every three
// seconds once its port is forwarded: a retry prints a new one); and the focused
// remote terminal every three seconds when something other than a shell runs
// there (an agent running the login for you). These reads take the screen
// only, never history, so they never scroll the program. Nothing is read otherwise.
// `forward.scan` reads the focused terminal now, with its history;
// `forward.stop` closes every tunnel. Both are mod commands for keys.json or
// `herdr-app do forward.scan`.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { hc, terminals, focused, notify, nextCommand, theme } from "herdr";

// ms between screen reads of a terminal running a login, and of the focused
// remote terminal; ms before the same machine:port is tried again.
const FAST = 1000, SLOW = 3000, RETRY = 20000;
// Lines of history read above the screen: while watching, and for forward.scan.
// Watching reads the screen only: reading history of a full-screen program
// (Claude Code's fullscreen TUI) makes hc scroll it and back, which sends the
// program wheel events and a redraw every read and fights the person's own
// scrolling. A callback URL being printed is on the screen anyway.
const HISTORY = 0, SCAN_HISTORY = 300;
// Seconds a tunnel lives at most.
const KEEP = 900;
// A program is a login when its name is one of these, or its command line
// (or Herdr's name for it) says so.
const LOGIN_CLIS = new Set(["aws", "gcloud", "az", "gh"]);
const LOGIN = /\b(login|auth|sso|oauth|signin|sign-in|authenticate|authorize)\b/i;
// A loopback callback in an OAuth authorize URL, as printed (`redirect_uri=http%3A%2F%2F127.0.0.1%3A45157%2Foauth%2Fcallback`)
// or decoded. Matched against the screen with its whitespace removed, so a URL
// wrapped over several lines is whole again.
const CALLBACK = /redirect_uri(?:=|%3D)https?(?:%3A%2F%2F|:\/\/)(?:127\.0\.0\.1|localhost|0\.0\.0\.0|%5B%3A%3A1%5D|\[::1\])(?:%3A|:)(\d{2,5})(?!\d)/gi;
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-T"];
// Exit codes of the remote watcher that aren't failures: 0 the listener closed
// (login done), 3 nothing listened there to begin with, 4 the time was up.
const QUIET_EXITS = new Set([0, 3, 4]);
// Tunnel terminals are named `fwd-<machine>-<port>-<random>`.
const NAME = "fwd-";

export const ports = (text) => {
  const flat = String(text ?? "").replace(/\s+/g, "");
  const out = [];
  for (const m of flat.matchAll(CALLBACK)) {
    const port = Number(m[1]);
    if (port > 0 && port < 65536 && !out.includes(port)) out.push(port);
  }
  return out;
};

// The remote side: ends when nothing listens on the port any more. Single
// quotes are the outer shell's, so none inside.
export const remoteScript = (port) =>
  `sh -c 'p=${port}; end=$(( $(date +%s) + ${KEEP} ));` +
  ` l() { if command -v ss >/dev/null 2>&1; then ss -Hltn "sport = :$p" 2>/dev/null | grep -q .;` +
  ` elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; else return 2; fi; };` +
  ` l; r=$?; [ $r -eq 1 ] && exit 3;` +
  ` while [ $(date +%s) -lt $end ]; do sleep 1; l; r=$?; [ $r -eq 1 ] && exit 0; done; exit 4'`;

const remote = (address) => String(address ?? "").includes("/");
const machineOf = (address) => String(address).split("/")[0];
const words = (t) => {
  const fg = t?.foreground ?? {};
  return [t?.program?.key, t?.program?.name, fg.name, ...(Array.isArray(fg.argv) ? fg.argv : []), t?.title].filter(Boolean).map(String);
};
// A live remote terminal running a login command (not a shell, not an agent).
export const loginLike = (t) => {
  if (!t || t.state !== "live" || !remote(t.address) || t.program?.shell || t.program?.agent) return false;
  const w = words(t);
  return w.some((x) => LOGIN_CLIS.has(x.toLowerCase())) || LOGIN.test(w.join(" "));
};
// What to read: every login-like remote terminal fast; the focused remote
// terminal slowly when something other than a shell runs there.
export const targets = (ts, focus, forwarded = new Set()) => {
  const out = ts.filter(loginLike).map((t) => ({ address: t.address, period: forwarded.has(t.address) ? SLOW : FAST }));
  const f = ts.find((t) => t.address === focus);
  if (f && f.state === "live" && remote(f.address) && !f.program?.shell && !out.some((o) => o.address === f.address)) out.push({ address: f.address, period: SLOW });
  return out;
};
const lastLines = (text, n) => String(text ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n).join("\n");
const parse = (r) => { try { return r?.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };

export default class Forward extends View {
  init(_props, cx) {
    this.active = {};      // "machine:port" -> { machine, port, from, terminal, since, state: "starting" | "up", stopped?, finishing? }
    this.tried = {};       // "machine:port" -> when it was last started
    this.lastRead = {};    // address -> when its screen was last read
    this.reading = new Set();
    this.machines = null;  // hc machine ls, { at, list }
    this.timer = null;
    cx.spawn(async (cx) => { await this.adopt(cx); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        try {
          if (c === "scan") await this.scan(cx);
          else if (c === "stop") await this.stopAll(cx);
        } catch (e) {
          console.log(`forward: ${c} failed: ${e?.stack ?? e}`);
          notify({ title: `forward.${c} failed`, body: String(e?.message ?? e), level: "error" });
        }
      }
    });
  }

  // Tunnels an earlier build of this mod (or a previous start) left running.
  // `hc ls` prints no labels, so the name says which terminals are ours; `hc get` has the rest.
  async adopt(cx) {
    const d = parse(await hc(["ls", "--all", "--json"]).catch(() => null));
    for (const row of d?.terminals ?? []) {
      if (!String(row.name ?? "").startsWith(NAME) || remote(row.address)) continue;
      const t = parse(await hc(["get", row.address, "--json"]).catch(() => null));
      const port = Number(t?.labels?.["forward.port"]);
      if (!port) continue;
      const machine = t.labels?.["forward.machine"] ?? "?";
      const key = `${machine}:${port}`;
      if (t.state === "live") {
        this.active[key] ??= { machine, port, from: t.labels?.["forward.from"] ?? null, terminal: t.address, since: Date.now(), state: "up" };
      } else {
        await hc(["rm", t.address]).catch(() => null);
      }
    }
    cx.notify();
  }

  ensureTimer(cx) {
    if (this.timer) return;
    if (!Object.keys(this.active).length && !targets(terminals(), focused()?.terminal).length) return;
    this.timer = cx.timer.every(1000, (cx) => this.tick(cx));
  }

  tick(cx) {
    const now = Date.now();
    const ts = terminals();
    for (const [key, a] of Object.entries(this.active)) {
      if (a.state === "starting" || a.finishing) continue;
      const t = ts.find((x) => x.address === a.terminal);
      if (!t || t.state !== "live") {
        a.finishing = true;
        cx.spawn(async (cx) => { await this.finish(cx, key); });
      }
    }
    const reads = targets(ts, focused()?.terminal, new Set(Object.values(this.active).map((a) => a.from)));
    for (const { address, period } of reads) {
      if (this.reading.has(address) || now - (this.lastRead[address] ?? 0) < period) continue;
      this.lastRead[address] = now;
      this.reading.add(address);
      cx.spawn(async (cx) => {
        try { await this.read(cx, address, HISTORY); } finally { this.reading.delete(address); }
      });
    }
    if (!reads.length && !Object.keys(this.active).length) {
      this.timer?.cancel();
      this.timer = null;
    }
  }

  // Reads a terminal's screen and starts a tunnel for each callback port on it.
  async read(cx, address, lines) {
    const d = parse(await hc(["read", address, "--json", "--lines", String(lines)]).catch(() => null));
    if (!d) return [];
    const found = ports(d.text);
    for (const port of found) this.consider(cx, { machine: machineOf(address), port, from: address });
    return found;
  }

  consider(cx, hit) {
    const key = `${hit.machine}:${hit.port}`;
    const now = Date.now();
    if (this.active[key] || now - (this.tried[key] ?? 0) < RETRY) return;
    this.tried[key] = now;
    cx.spawn(async (cx) => {
      try { await this.start(cx, hit); } catch (e) {
        console.log(`forward: start failed: ${e?.stack ?? e}`);
        notify({ title: `Couldn't forward port ${hit.port} to ${hit.machine}`, body: String(e?.message ?? e), level: "error" });
      }
    });
  }

  async machine(name) {
    if (!this.machines || Date.now() - this.machines.at > 60000 || !this.machines.list.some((m) => m.name === name)) {
      const d = parse(await hc(["machine", "ls", "--json"]).catch(() => null));
      this.machines = { at: Date.now(), list: d?.machines ?? [] };
    }
    return this.machines.list.find((m) => m.name === name) ?? null;
  }

  async start(cx, hit) {
    const key = `${hit.machine}:${hit.port}`;
    const m = await this.machine(hit.machine);
    if (!m) { notify({ title: `Couldn't forward port ${hit.port}`, body: `${hit.machine} isn't in hc machine ls.`, level: "error" }); return; }
    if (m.via) { notify({ title: `Couldn't forward port ${hit.port} to ${hit.machine}`, body: "That machine is reached through a command, not ssh. Forward the port yourself.", level: "error" }); return; }
    const name = `${NAME}${hit.machine.slice(0, 12)}-${hit.port}-${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9_-]/gi, "-").toLowerCase().slice(0, 32);
    const r = await hc([
      "run", "--bg", "--json", "--no-parent", "--no-notify", "--name", name,
      "--label", `forward.port=${hit.port}`, "--label", `forward.machine=${hit.machine}`, "--label", `forward.from=${hit.from ?? ""}`,
      "--", "ssh", ...SSH_OPTS, "-L", `${hit.port}:localhost:${hit.port}`, m.target, remoteScript(hit.port),
    ]);
    const address = parse(r)?.address;
    if (!address) throw new Error(lastLines(r?.stderr || r?.stdout, 3) || "hc run gave no terminal");
    this.active[key] = { ...hit, terminal: address, since: Date.now(), state: "starting" };
    cx.notify();
    cx.timer.after(1500, (cx) => { this.settle(cx, key).catch((e) => console.log(`forward: settle failed: ${e?.stack ?? e}`)); });
  }

  // A moment after the start: connected and forwarding, or already over.
  async settle(cx, key) {
    const a = this.active[key];
    if (!a) return;
    const t = parse(await hc(["get", a.terminal, "--json"]).catch(() => null));
    if (t?.state === "live") {
      a.state = "up";
      notify({ title: `Port ${a.port} forwarded to ${a.machine}`, body: `The login's browser callback to 127.0.0.1:${a.port} reaches ${a.machine} now. The tunnel closes when the login is done.`, level: "success" });
      cx.notify();
      return;
    }
    a.finishing = true;
    await this.finish(cx, key, t);
  }

  // The tunnel's terminal ended: say why if it failed, then forget it.
  async finish(cx, key, fact) {
    const a = this.active[key];
    if (!a) return;
    const t = fact ?? parse(await hc(["get", a.terminal, "--json"]).catch(() => null));
    if (t?.state === "live") { a.finishing = false; return; }   // terminals() lagged behind; still up
    const code = t?.exit_code;
    if (!a.stopped && !(code != null && QUIET_EXITS.has(code))) {
      const out = parse(await hc(["read", a.terminal, "--json", "--lines", "20"]).catch(() => null));
      const why = lastLines(out?.text, 3) || (t?.signal ? `ended by signal ${t.signal}` : code != null ? `ssh exited with ${code}` : "the tunnel's terminal is gone");
      notify({ title: `Couldn't forward port ${a.port} to ${a.machine}`, body: why, level: "error" });
    }
    await hc(["rm", a.terminal]).catch(() => null);
    delete this.active[key];
    cx.notify();
  }

  async stop(cx, key) {
    const a = this.active[key];
    if (!a) return;
    a.stopped = true;
    await hc(["kill", a.terminal]).catch(() => null);
    cx.notify();
  }

  async stopAll(cx) {
    for (const key of Object.keys(this.active)) await this.stop(cx, key);
  }

  // forward.scan: the focused terminal, now, with history.
  async scan(cx) {
    const address = focused()?.terminal;
    if (!address) { notify({ title: "Nothing to forward", body: "No terminal is focused.", level: "info" }); return; }
    if (!remote(address)) { notify({ title: "Nothing to forward", body: "This terminal runs on this computer, where the browser already reaches its ports.", level: "info" }); return; }
    const found = await this.read(cx, address, SCAN_HISTORY);
    if (!found.length) notify({ title: "Nothing to forward", body: `No login callback URL (redirect_uri=http://127.0.0.1:<port>/...) on ${address}'s screen.`, level: "info" });
    cx.notify();
  }

  render(cx) {
    this.ensureTimer(cx);
    const list = Object.values(this.active);
    if (!list.length) return div();
    const t = theme();
    return v_flex().gap(2).text_size(12).children(list.map((a) => {
      const key = `${a.machine}:${a.port}`, id = key.replace(/[^a-z0-9]/gi, "-");
      return h_flex().id(`fwd-${id}`).px(10).h(26).gap(8).items_center()
        .child(div().text_color(a.state === "up" ? t.accent : t.dim).child("⇄"))
        .child(div().text_color(t.foreground).child(`127.0.0.1:${a.port} → ${a.machine}`))
        .child(div().text_color(t.dim).child(a.state === "up" ? "forwarded" : "connecting…"))
        .child(div().id(`fwd-stop-${id}`).px(4).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground)).child("×")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.stop(cx, key).catch((e) => console.log(`forward: stop failed: ${e?.stack ?? e}`)); }));
    }));
  }
}
