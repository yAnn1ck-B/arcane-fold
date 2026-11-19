import { useEffect, useId } from "react";
import "@/styles/tooltips.css";

function hintAnchor(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>("[data-hint]") : null;
}

/** One tooltip layer for data-hint controls, including controls inside native dialogs. */
export default function Tooltips() {
  const id = useId();
  useEffect(() => {
    const tip = document.createElement("div");
    tip.id = id;
    tip.className = "ui-tooltip";
    tip.setAttribute("role", "tooltip");
    let displayed: HTMLElement | null = null;
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let dismissed: HTMLElement | null = null;
    let leave: number | undefined;
    const watchVisibleHint = new MutationObserver(refresh);

    function describe(anchor: HTMLElement, enabled: boolean) {
      const ids = (anchor.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      const next = ids.filter((existing) => existing !== id);
      if (enabled) next.push(id);
      if (next.length) anchor.setAttribute("aria-describedby", next.join(" "));
      else anchor.removeAttribute("aria-describedby");
    }

    function hide() {
      if (displayed) describe(displayed, false);
      watchVisibleHint.disconnect();
      tip.remove();
      displayed = null;
    }

    function place() {
      if (!displayed) return;
      if (!displayed.isConnected || !displayed.getClientRects().length) {
        hide();
        return;
      }
      const box = displayed.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      if (box.bottom <= 0 || box.top >= height || box.right <= 0 || box.left >= width) {
        hide();
        return;
      }
      const margin = 8;
      const gap = 4;
      const centered = box.left + (box.width - tip.offsetWidth) / 2;
      tip.style.left = `${Math.max(margin, Math.min(centered, width - tip.offsetWidth - margin))}px`;
      const below = box.bottom + gap;
      const above = box.top - tip.offsetHeight - gap;
      tip.style.top = `${below + tip.offsetHeight <= height - margin ? below : Math.max(margin, above)}px`;
    }

    function refresh() {
      if (hovered && !hovered.isConnected) hovered = null;
      if (focused && !focused.isConnected) focused = null;
      const anchor = hovered ?? focused;
      if (dismissed !== anchor) dismissed = null;
      const hint = anchor?.dataset.hint;
      if (!anchor || !hint || dismissed) {
        hide();
        return;
      }
      if (anchor !== displayed) {
        hide();
        displayed = anchor;
        // A multiplayer refresh may replace the control or change its hint under the pointer.
        watchVisibleHint.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["data-hint", "hidden", "open"],
        });
      }
      const layer = anchor.closest("dialog[open]") ?? document.body;
      if (tip.parentElement !== layer) layer.appendChild(tip);
      if (tip.textContent !== hint) tip.textContent = hint;
      // An icon's accessible name already conveys an identical tooltip label.
      describe(anchor, hint !== (anchor.getAttribute("aria-label") ?? anchor.textContent?.trim()));
      place();
    }

    function follow(target: EventTarget | null) {
      window.clearTimeout(leave);
      const next = target === tip ? displayed : hintAnchor(target);
      if (next === hovered) return;
      if (next) {
        hovered = next;
        refresh();
      } else {
        // Give the pointer time to move from a control across the gap to its tooltip.
        leave = window.setTimeout(() => { hovered = null; refresh(); }, 120);
      }
    }

    function pointerOver(event: PointerEvent) {
      if (event.pointerType !== "touch") follow(event.target);
    }
    function pointerOut(event: PointerEvent) {
      if (event.pointerType !== "touch") follow(event.relatedTarget);
    }
    function focusIn(event: FocusEvent) {
      const anchor = hintAnchor(event.target);
      focused = anchor?.matches(":focus-visible:not([data-auto-focus])") ? anchor : null;
      if (focused) hovered = null;
      refresh();
    }
    function focusOut() {
      focused = null;
      refresh();
    }
    function dismiss() {
      dismissed = displayed;
      hide();
    }
    function keyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || !displayed) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }

    document.addEventListener("pointerover", pointerOver, true);
    document.addEventListener("pointerout", pointerOut, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("focusout", focusOut, true);
    document.addEventListener("keydown", keyDown, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.clearTimeout(leave);
      document.removeEventListener("pointerover", pointerOver, true);
      document.removeEventListener("pointerout", pointerOut, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", focusIn, true);
      document.removeEventListener("focusout", focusOut, true);
      document.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      hide();
    };
  }, [id]);
  return null;
}
