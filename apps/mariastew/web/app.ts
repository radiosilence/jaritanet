declare global {
  var ms: {
    pasteInto(field: HTMLInputElement): void;
    clickOnEnter(evt: KeyboardEvent, button: HTMLButtonElement): void;
    browseUrl(evt: Event): string | null;
  };
}

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
    navigator.clipboard?.readText().then(
      (text) => {
        field.value = text.trim();
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
    const dir = (evt.target as HTMLElement).closest<HTMLElement>("[data-dir]")
      ?.dataset.dir;
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
