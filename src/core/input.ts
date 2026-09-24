// Keyboard + mouse input with per-frame edge detection and pointer lock.
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  /** Edges awaiting a physics tick; render frames can run without a fixed update. */
  private fixedPressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  mouseButtons = new Set<number>();
  private mousePressed = new Set<number>();
  /** When false, game keys are ignored (text fields, menus). */
  private active = true;
  get enabled() { return this.active; }
  set enabled(value: boolean) { this.active = value; if (!value) this.reset(); }

  constructor(private el: HTMLElement) {
    addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (!this.enabled || target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) return;
      if (!this.down.has(e.code)) { this.pressed.add(e.code); this.fixedPressed.add(e.code); }
      this.down.add(e.code);
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    });
    addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset(); });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.mouseButtons.add(e.button);
      this.mousePressed.add(e.button);
    });
    addEventListener('mouseup', (e) => this.mouseButtons.delete(e.button));
    addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
  }

  requestPointerLock() {
    if (!document.pointerLockElement) this.el.requestPointerLock?.();
  }
  get locked() { return !!document.pointerLockElement; }

  isDown(code: string) { return this.enabled && this.down.has(code); }
  wasPressed(code: string) { return this.enabled && this.pressed.has(code); }
  wasReleased(code: string) { return this.enabled && this.released.has(code); }
  mouseDown(b = 0) { return this.enabled && this.mouseButtons.has(b); }
  mouseWasPressed(b = 0) { return this.enabled && this.mousePressed.has(b); }

  /** Consume an edge once, even when a render frame runs several physics ticks. */
  consumePress(code: string) {
    return this.enabled && this.fixedPressed.delete(code);
  }

  /** Discard unused edges after a physics tick (e.g. jump pressed while driving). */
  endFixedStep() { this.fixedPressed.clear(); }

  reset() {
    this.down.clear();
    this.fixedPressed.clear();
    this.mouseButtons.clear();
    this.endFrame();
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
