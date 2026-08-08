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
   * Offer a magnet from the clipboard to a field that is still empty.
   *
   * Has to be called from the click that opens the dialog: every browser gates
   * `readText()` on transient user activation and `showModal()` does not spend
   * it. Whether a prompt appears is the browser's call — Safari draws its own
   * Paste button, Chrome grants it silently on the gesture, an insecure origin
   * has no `navigator.clipboard` at all — and none of those are an error, they
   * leave a field to type into. Only a magnet is offered, since that is all
   * `/add` accepts, and only into an empty field, because the prompt can
   * outlast the moment someone gives up waiting and starts typing.
   */
  pasteMagnet(field) {
    navigator.clipboard?.readText().then(
      (text) => {
        const magnet = text.trim();
        if (!field.value && magnet.startsWith("magnet:?")) field.value = magnet;
      },
      () => {},
    );
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
    return dir === undefined ? null : `/browse?path=${encodeURIComponent(dir)}`;
  },
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
  // visualViewport scrolls fire on every pan, and the vast majority report the
  // same number — skipping those keeps a scroll from invalidating style.
  let published = -1;
  const publish = () => {
    const covered = Math.round(
      Math.max(
        0,
        document.documentElement.clientHeight -
          viewport.height -
          viewport.offsetTop,
      ),
    );
    if (covered === published) return;
    published = covered;
    document.documentElement.style.setProperty(
      "--keyboard-inset",
      `${covered}px`,
    );
  };

  viewport.addEventListener("resize", publish);
  viewport.addEventListener("scroll", publish);
  publish();
}
