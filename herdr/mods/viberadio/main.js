// viberadio: the shared Slack radio, as a popup. It only drives the `viberadio` command (~/.local/bin/viberadio),
// which runs the client as a systemd user service and plays in mpv; this panel shows its status and sends commands.
// Volume, mute and tuning in or out touch this computer only. Skip is the exception: it skips for everyone.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, theme } from "herdr";

const REFRESH_MS = 2000, ARM_MS = 3000;
const bin = () => `${home()}/.local/bin/viberadio`;

export default class Viberadio extends View {
  init(_props, cx) {
    this.status = undefined; // undefined: not asked yet; null: the client is off
    this.error = null; this.busy = false; this.armed = 0;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  async run(args) {
    const r = await exec(bin(), args, { timeout: 20000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `viberadio ${args[0]} failed`).trim().split("\n").pop());
    return r.stdout;
  }

  refresh(cx) {
    if (this.busy) return;
    cx.spawn(async (cx) => {
      try { this.status = JSON.parse(await this.run(["status", "--json"])); this.error = null; }
      catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  act(cx, ...args) {
    if (this.busy) return;
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      try { await this.run(args); this.error = null; }
      catch (e) { this.error = String(e?.message ?? e); }
      this.busy = false;
      try { this.status = JSON.parse(await this.run(["status", "--json"])); } catch { /* the error above says why */ }
      cx.notify();
    });
  }

  button(id, label, onClick, t, { color = t.muted, wide = false } = {}) {
    return div().id(id).px(wide ? 12 : 9).h(26).flex().items_center().rounded(7).cursor_pointer().text_size(12).text_color(color)
      .bg(t.raised).hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  render() {
    const t = theme(), s = this.status;
    const on = Boolean(s), n = s?.now;
    const dot = !on ? t.dim : !s.connected || s.error ? t.ansi1 : n?.playing ? t.ansi2 : t.blocked;
    const skipArmed = Date.now() - this.armed < ARM_MS;
    const sync = s?.driftMs == null ? "" : Math.abs(s.driftMs) <= 1000 ? `in sync (${s.driftMs} ms)` : `${s.driftMs} ms off`;

    const head = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().size(8).rounded(4).bg(dot))
      .child(div().font_semibold().child("viberadio"))
      .child(div().flex_1())
      .when(on, (e) => e.child(div().text_size(11).text_color(t.dim).child(`${s.listeners ?? "?"} listening`)));

    const body = v_flex().flex_1().min_h(0).p(14).gap(10);
    if (s === undefined && !this.error) body.child(div().text_color(t.dim).child("Loading…"));
    else if (!on) body.child(div().text_color(t.muted).child("Not tuned in."));
    else if (n) body
      .child(div().text_size(14).font_semibold().child(n.title))
      .child(div().text_size(11.5).text_color(t.muted).child([n.author, n.addedBy && `added by ${n.addedBy}`].filter(Boolean).join(" · ")))
      .child(div().text_size(11).text_color(t.dim).child([n.playing ? "playing" : "starting…", sync].filter(Boolean).join(" · ")));
    else body.child(div().text_color(t.muted).child(s.connected ? "Nothing is playing." : "Connecting…"));
    if (on && !s.connected) body.child(div().text_size(11).text_color(t.ansi1).child("Not connected, retrying"));
    if (s?.error) body.child(div().text_size(11).text_color(t.ansi1).child(s.error));
    if (this.error) body.child(div().text_size(11).text_color(t.ansi1).child(this.error));

    const controls = h_flex().flex_none().p(12).gap(8).items_center().border_t(1).border_color(t.border)
      .child(this.button("vr-power", this.busy ? "…" : on ? "Stop" : "Tune in", (cx) => this.act(cx, on ? "stop" : "start"), t, { color: t.foreground, wide: true }))
      .when(on, (e) => e
        .child(this.button("vr-mute", s.muted ? "Unmute" : "Mute", (cx) => this.act(cx, "mute"), t))
        .child(this.button("vr-vol-down", "−", (cx) => this.act(cx, "volume", "-5"), t))
        .child(div().w(40).flex().justify_center().text_size(12).text_color(s.muted ? t.dim : t.foreground).child(`${s.volume}%`))
        .child(this.button("vr-vol-up", "+", (cx) => this.act(cx, "volume", "+5"), t))
        .child(div().flex_1())
        // Skip ends the track for every listener on the station, so it takes two clicks.
        .child(this.button("vr-skip", skipArmed ? "Skip for everyone?" : "Skip", (cx) => {
          // The refresh timer redraws every 2 s, which is what turns the armed label back after ARM_MS.
          if (skipArmed) { this.armed = 0; this.act(cx, "skip"); } else { this.armed = Date.now(); cx.notify(); }
        }, t, { color: skipArmed ? t.ansi1 : t.muted })));

    return v_flex().id("viberadio").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12.5)
      .child(head).child(body).child(controls);
  }
}
