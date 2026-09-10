const DEFAULT_INPUT_LENGTH = 100;

/** Return the remote key changes represented by a mobile input event. */
export function mobileInputChanges(oldValue, newValue, selectionStart = newValue.length) {
  const newLength = Math.max(selectionStart ?? newValue.length, newValue.length);
  const oldLength = oldValue.length;
  let inputCount = newLength - oldLength;
  let backspaces = inputCount < 0 ? -inputCount : 0;

  for (let index = 0; index < Math.min(oldLength, newLength); index += 1) {
    if (newValue.charAt(index) !== oldValue.charAt(index)) {
      inputCount = newLength - index;
      backspaces = oldLength - index;
      break;
    }
  }

  return {
    backspaces,
    text: newValue.slice(newLength - inputCount, newLength),
  };
}

/** True for browsers that can present a touch keyboard. */
export function isTouchBrowser(navigatorLike = globalThis.navigator, windowLike = globalThis) {
  return Boolean(navigatorLike?.maxTouchPoints > 0 || "ontouchstart" in windowLike);
}

/** Add a relative touch trackpad that drives noVNC's mouse canvas. */
export function attachMobileTrackpad(
  rfb,
  { button, surface, documentTarget = globalThis.document, sensitivity = 1.5 },
) {
  if (!button || !surface || !documentTarget || rfb.viewOnly) return () => {};

  let enabled = false;
  let pointerId = null;
  let lastX = 0;
  let lastY = 0;
  let cursorX = null;
  let cursorY = null;
  let moved = false;

  const canvas = () => surface.querySelector("canvas");
  const mouse = (type, buttonNumber = 0) => {
    const target = canvas();
    if (!target || cursorX == null || cursorY == null) return;
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: cursorX,
        clientY: cursorY,
        button: buttonNumber,
        buttons: type === "mousedown" ? 1 : 0,
      }),
    );
  };
  const positionCursor = (deltaX = 0, deltaY = 0) => {
    const target = canvas();
    if (!target) return;
    const bounds = target.getBoundingClientRect();
    cursorX ??= bounds.left + bounds.width / 2;
    cursorY ??= bounds.top + bounds.height / 2;
    cursorX = Math.max(bounds.left, Math.min(bounds.right - 1, cursorX + deltaX * sensitivity));
    cursorY = Math.max(bounds.top, Math.min(bounds.bottom - 1, cursorY + deltaY * sensitivity));
    mouse("mousemove");
  };
  const setEnabled = (next) => {
    enabled = next;
    const label = enabled ? "Use direct touch" : "Use trackpad";
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.classList.toggle("active", enabled);
    surface.classList.toggle("trackpad-active", enabled);
    rfb.showDotCursor = enabled;
    if (enabled) positionCursor();
  };
  const onButtonClick = () => setEnabled(!enabled);
  const shouldHandle = (event) => enabled && event.pointerType !== "mouse";
  const consume = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerDown = (event) => {
    if (!shouldHandle(event) || pointerId !== null) return;
    consume(event);
    pointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    moved = false;
    event.target.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event) => {
    if (!shouldHandle(event) || event.pointerId !== pointerId) return;
    consume(event);
    const deltaX = event.clientX - lastX;
    const deltaY = event.clientY - lastY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 1) moved = true;
    positionCursor(deltaX, deltaY);
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const finishPointer = (event, click) => {
    if (!shouldHandle(event) || event.pointerId !== pointerId) return;
    consume(event);
    if (click && !moved) {
      mouse("mousedown");
      mouse("mouseup");
    }
    pointerId = null;
  };
  const onPointerUp = (event) => finishPointer(event, true);
  const onPointerCancel = (event) => finishPointer(event, false);

  button.hidden = false;
  button.addEventListener("click", onButtonClick);
  surface.addEventListener("pointerdown", onPointerDown, true);
  surface.addEventListener("pointermove", onPointerMove, true);
  surface.addEventListener("pointerup", onPointerUp, true);
  surface.addEventListener("pointercancel", onPointerCancel, true);

  return () => {
    button.removeEventListener("click", onButtonClick);
    surface.removeEventListener("pointerdown", onPointerDown, true);
    surface.removeEventListener("pointermove", onPointerMove, true);
    surface.removeEventListener("pointerup", onPointerUp, true);
    surface.removeEventListener("pointercancel", onPointerCancel, true);
    surface.classList.remove("trackpad-active");
    rfb.showDotCursor = false;
  };
}

/**
 * Connect a hidden text field to noVNC so iOS and Android keyboards can type
 * into the remote desktop. This follows noVNC's full-interface keyboard flow.
 */
export function attachMobileKeyboard(
  rfb,
  {
    button,
    input,
    Keyboard,
    backspaceKeysym,
    lookupKeysym,
    documentTarget = globalThis.document,
    windowTarget = documentTarget?.defaultView ?? globalThis,
  },
) {
  if (!button || !input || !Keyboard || !documentTarget || rfb.viewOnly) return () => {};

  let lastValue = "";
  let closeOnButtonClick = false;
  const visualViewport = windowTarget?.visualViewport;
  const viewportRoot = documentTarget.documentElement;
  const updateVisibleViewport = () => {
    if (documentTarget.activeElement !== input || !visualViewport) return;
    viewportRoot.style.setProperty("--mobile-visual-height", `${visualViewport.height}px`);
    viewportRoot.style.setProperty("--mobile-visual-top", `${visualViewport.offsetTop}px`);
  };
  const clearVisibleViewport = () => {
    viewportRoot.style.removeProperty("--mobile-visual-height");
    viewportRoot.style.removeProperty("--mobile-visual-top");
  };
  const resetInput = () => {
    input.value = "_".repeat(DEFAULT_INPUT_LENGTH - 1);
    lastValue = input.value;
  };
  const setOpen = (open) => {
    const label = open ? "Hide keyboard" : "Show keyboard";
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.classList.toggle("active", open);
    viewportRoot.classList.toggle("mobile-keyboard-open", open);
    if (open) updateVisibleViewport();
    else clearVisibleViewport();
    rfb.focusOnClick = !open;
  };
  const show = () => {
    input.focus();
    const length = input.value.length;
    input.setSelectionRange?.(length, length);
  };
  const hide = () => input.blur();
  const onButtonPressStart = () => {
    if (documentTarget.activeElement === input) closeOnButtonClick = true;
  };
  const onButtonClick = () => {
    const shouldHide = closeOnButtonClick || documentTarget.activeElement === input;
    closeOnButtonClick = false;
    if (shouldHide) hide();
    else show();
  };
  const onFocus = () => setOpen(true);
  const onBlur = () => setOpen(false);
  const onInput = (event) => {
    if (!lastValue) resetInput();
    const newValue = event.target.value;
    const changes = mobileInputChanges(lastValue, newValue, event.target.selectionStart);
    for (let index = 0; index < changes.backspaces; index += 1) {
      rfb.sendKey(backspaceKeysym, "Backspace");
    }
    for (const character of changes.text) rfb.sendKey(lookupKeysym(character.codePointAt(0)));

    if (newValue.length > 2 * DEFAULT_INPUT_LENGTH) {
      resetInput();
    } else if (newValue.length < 1) {
      resetInput();
      input.blur();
      setTimeout(() => input.focus(), 0);
    } else {
      lastValue = newValue;
    }
  };
  const keepOpen = (event) => {
    if (documentTarget.activeElement !== input) return;
    // Let the toggle control dismiss without preventDefault swallowing the tap.
    if (event.target === button || button.contains?.(event.target)) return;
    event.preventDefault();
  };
  // Touch/pointer first: blur can run before a synthesized mousedown on mobile.
  const keepOpenEvents = ["pointerdown", "touchstart", "mousedown"];

  resetInput();
  const keyboard = new Keyboard(input);
  keyboard.onkeyevent = (keysym, code, down) => rfb.sendKey(keysym, code, down);
  keyboard.grab();
  button.hidden = false;
  for (const type of keepOpenEvents) button.addEventListener(type, onButtonPressStart);
  button.addEventListener("click", onButtonClick);
  input.addEventListener("input", onInput);
  input.addEventListener("focus", onFocus);
  input.addEventListener("blur", onBlur);
  visualViewport?.addEventListener("resize", updateVisibleViewport);
  visualViewport?.addEventListener("scroll", updateVisibleViewport);
  for (const type of keepOpenEvents) {
    documentTarget.documentElement.addEventListener(type, keepOpen, true);
  }

  return () => {
    keyboard.ungrab?.();
    for (const type of keepOpenEvents) button.removeEventListener(type, onButtonPressStart);
    button.removeEventListener("click", onButtonClick);
    input.removeEventListener("input", onInput);
    input.removeEventListener("focus", onFocus);
    input.removeEventListener("blur", onBlur);
    visualViewport?.removeEventListener("resize", updateVisibleViewport);
    visualViewport?.removeEventListener("scroll", updateVisibleViewport);
    viewportRoot.classList.remove("mobile-keyboard-open");
    clearVisibleViewport();
    for (const type of keepOpenEvents) {
      documentTarget.documentElement.removeEventListener(type, keepOpen, true);
    }
  };
}
