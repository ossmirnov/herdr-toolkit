// Open a file by path on the focused space's machine and show it in a tab of the space.
// One mod, two faces. Without props().path it is the Cmd-P popup (`mod.open:open-file`,
// keys.json): type a relative or absolute path, Tab completes, Enter opens. With
// props().path it is the tab the popup opens (`tab.new {name, mod: "open-file",
// props: {path, on}}`): code with syntax colors in Herdr's read-only editor (the
// same one the Files panel uses), markdown rendered, images shown, live reload.
import { View } from "gpui-kit";
import { props } from "herdr";
import Ask from "./ask.js";
import Show from "./view.js";

export default class OpenFile extends View {
  init(_props, cx) {
    this.face = props()?.path ? new Show() : new Ask();
    this.face.init(cx);
  }

  render(cx) {
    return this.face.render(cx);
  }

  async close(cx) {
    await this.face.cleanup?.(cx);
  }
}
