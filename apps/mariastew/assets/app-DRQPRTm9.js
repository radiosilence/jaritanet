//#region web/app.ts
/**
* The Datastar fetch events that are evidence the stream is carrying bytes.
*
* An allowlist rather than a list of the failures to ignore, so an event type
* nobody here has heard of cannot be mistaken for liveness — which is the
* whole quantity being measured.
*/
const STREAM_FRAMES = /* @__PURE__ */ new Set([
	"started",
	"datastar-heartbeat",
	"datastar-patch-elements",
	"datastar-patch-signals"
]);
/**
* Three of the server's five-second heartbeats, and a little more.
*
* Two would reconnect over one frame lost to a stalled event loop, which is a
* connection that is fine. The cost of waiting the third is the width of the
* window in which the page shows something out of date, and against a phone
* that has been in a pocket that window is nothing.
*/
const STREAM_TIMEOUT_MS = 16e3;
let streamLastSeen = Date.now();
/** Set by a 401: the stream is refused rather than lost, and no reconnect
* fixes that. Cleared by anything the server actually serves. */
let streamRefused = false;
/**
* The behaviours that do not belong in an attribute.
*
* Datastar evaluates `data-on:*` as a function body, so an attribute holds
* anything JavaScript can express — which is how a click handler becomes a
* program written in HTML, invisible to oxlint and oxfmt and unreadable at the
* width a template gives it. Signal work and one `@action` stay inline, where
* they read as markup; everything with control flow in it lives here.
*
* A global rather than an export, because a Datastar expression sees only
* globals, `el`, `evt` and the signals.
*/
globalThis.ms = {
	/**
	* Put the clipboard into a field, from that field's own Paste button.
	*
	* `readText()` is gated on transient user activation everywhere and, on iOS,
	* on a Paste bubble Safari draws itself and no page can suppress. That gate
	* is why this hangs off a button beside the field rather than the tap that
	* opens the sheet: Safari anchors its bubble to the touch that asked, so
	* asking from the header put a Paste button at the top of the screen for a
	* field at the bottom of it, and asked on every open whether or not there
	* was anything anyone wanted pasted (#353).
	*
	* Whatever is on the clipboard goes in, magnet or not. Filtering to magnets
	* made sense while the read was automatic, since nothing unasked-for should
	* land in a field — but a button that answers an explicit tap by doing
	* nothing reads as broken, where a wrong value is visible and `/add` says
	* what is wrong with it.
	*
	* A refused prompt and a browser with no clipboard API are both no-ops
	* rather than errors: either way there is a field to type into.
	*/
	pasteInto(field) {
		navigator.clipboard?.readText().then((text) => {
			field.value = text.trim();
		}, () => {});
	},
	/**
	* Wire Enter to a button that sits outside the field's own form.
	*
	* Both submit buttons here are pinned outside the form they submit, so there
	* is no implicit submission to inherit and the keyboard's Go key did nothing
	* at all — on a phone, at the moment the paste just happened. Clicking the
	* real button keeps one definition of what it does.
	*/
	clickOnEnter(evt, button) {
		if (evt.key !== "Enter") return;
		evt.preventDefault();
		button.click();
	},
	/**
	* The listing to fetch for a click inside the picker, or null if it hit no
	* folder — the empty space around the buttons, or the path line above them.
	*
	* One delegated handler serves the whole listing: a root with a hundred-plus
	* children is one level of browsing, and a `@get` per row was that many
	* expressions to compile on every morph and that many URLs inlined into the
	* response. A path arriving as a plain attribute value is also never parsed
	* as an expression, so a folder named with a quote cannot break out of it.
	*/
	browseUrl(evt) {
		const dir = evt.target.closest("[data-dir]")?.dataset.dir;
		return dir === void 0 ? null : `/browse?path=${encodeURIComponent(dir)}`;
	},
	/**
	* Take one of the stream's own Datastar fetch events.
	*
	* A frame is proof the connection is there and resets the clock
	* `streamLost` reads — a row patch, the heartbeat behind it
	* (`routes::HEARTBEAT`), or Datastar announcing it has *started* a request.
	* That last one is what stops a reconnect that cannot connect from retrying
	* every tick: the attempt itself resets the clock, so a server that is down
	* is asked once per timeout.
	*
	* Which is exactly why a 401 has to stop it outright. A session lives only in
	* the pod's memory, so the deploy that ends the stream is usually the deploy
	* that signs the page out, and `require_session` answers a Datastar request
	* with a status where a navigation would get the login redirect —
	* deliberately, since a stream cannot be redirected. No reconnect gets past
	* that, and every attempt would reset the clock for the next one, so the page
	* would ask forever and never arrive anywhere.
	*
	* It is refused rather than dead, so a later frame lifts it: the reconnect on
	* returning to the foreground is unconditional, and if that one is served
	* the session came back and the watchdog should resume. `started` is not
	* enough — that is the asking, not the answer.
	*/
	streamEvent(evt) {
		const { type, argsRaw } = evt.detail;
		if (type === "error") {
			streamRefused ||= argsRaw?.status === "401";
			return;
		}
		if (!STREAM_FRAMES.has(type)) return;
		if (type !== "started") streamRefused = false;
		streamLastSeen = Date.now();
	},
	/**
	* Whether the stream has been quiet long enough to presume it is gone.
	*
	* This is the half of the problem `data-on:visibilitychange` cannot reach.
	* That one has a trigger — the page left and came back — and a pod replaced
	* under a tab nobody switched away from does not raise it. Neither does a
	* socket that stops carrying bytes without erroring, which is what a phone
	* hands back and what Datastar has no way to notice: it believes the request
	* is live, and there is nothing else to ask. Silence is the only evidence
	* available, which is why the server sends something to be silent *instead
	* of*.
	*
	* False while the document is hidden, whatever the clock says. Datastar
	* closes the stream on its way out of view and opens it again on the way
	* back, so quiet is correct there, and the timers driving this are throttled
	* anyway — a page returning after an hour would otherwise reconnect twice,
	* once for the return and once for the hour.
	*
	* False too once the stream has been refused. Quiet that nothing can cure is
	* not worth a request every timeout, forever, for as long as the tab is open.
	*/
	streamLost() {
		return !streamRefused && !document.hidden && Date.now() - streamLastSeen > STREAM_TIMEOUT_MS;
	}
};
/**
* Publish how much of the viewport the on-screen keyboard is covering, as
* `--keyboard-inset` on the root element.
*
* iOS Safari shrinks the visual viewport for its keyboard and leaves the
* layout viewport alone. Fixed positioning resolves against the layout one, so
* the bottom sheet opened underneath the keyboard and Safari scrolled the page
* chasing the focused field — the invisible dialog and the stray vertical
* scroll of #353, one cause. Nothing in CSS exposes the gap between the two
* viewports; this is the only place it can be measured.
*
* `offsetTop` is part of it: the visual viewport also pans, and what is
* covered is whatever sits below its bottom edge in layout coordinates.
*
* A browser that resizes its layout viewport for its own keyboard measures
* zero here, which is the fallback in the stylesheet too, so it is left alone.
* The guard is for the same reason `visualViewport` is read defensively
* anywhere: it is absent in older WebViews, and a missing keyboard offset is a
* sheet that behaves exactly as it did before this existed.
*/
const viewport = globalThis.visualViewport;
if (viewport) {
	let published = -1;
	const publish = () => {
		const covered = Math.round(Math.max(0, document.documentElement.clientHeight - viewport.height - viewport.offsetTop));
		if (covered === published) return;
		published = covered;
		document.documentElement.style.setProperty("--keyboard-inset", `${covered}px`);
	};
	viewport.addEventListener("resize", publish);
	viewport.addEventListener("scroll", publish);
	publish();
}
//#endregion
