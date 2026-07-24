export interface CameraCoordinates {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CameraPort {
  getPosition(): CameraCoordinates;
  getTarget(): CameraCoordinates;
  moveTo(
    position: CameraCoordinates,
    target: CameraCoordinates,
    transitionDurationMs: number,
  ): void;
  fitGraph(transitionDurationMs: number, paddingPixels: number): void;
}

interface NavigationControls {
  enablePan?: boolean;
  enableRotate?: boolean;
  enableZoom?: boolean;
  maxDistance?: number;
  minDistance?: number;
  screenSpacePanning?: boolean;
  addEventListener?(type: 'end' | 'start', listener: () => void): void;
  removeEventListener?(type: 'end' | 'start', listener: () => void): void;
}

export interface CameraControllerOptions {
  readonly controls?: object;
  readonly transitionDurationMs?: number;
  readonly onMotionStart: () => void;
  readonly onMotionEnd: (settleDurationMs: number) => void;
  readonly onError?: () => void;
}

export type WheelGesture = 'pan' | 'zoom';

const DEFAULT_TRANSITION_MS = 600;
const FIT_PADDING_PIXELS = 48;
const MIN_CAMERA_DISTANCE = 16;
const MAX_CAMERA_DISTANCE = 4_096;
const TRACKPAD_GESTURE_WINDOW_MS = 180;
const TRACKPAD_FIRST_DELTA_THRESHOLD = 48;
const WHEEL_ZOOM_SPEED = 0.0015;
const TOOLBAR_ZOOM_IN_FACTOR = 0.78;
const TOOLBAR_ZOOM_OUT_FACTOR = 1.28;
const DEFAULT_CAMERA_DISTANCE = 160;
const DEFAULT_VERTICAL_FIELD_OF_VIEW_RADIANS = (50 * Math.PI) / 180;

/**
 * Chromium does not expose the hardware source for a wheel event. Pinch is identifiable through
 * the control modifier; small pixel deltas are the best available signal for a two-finger swipe.
 * The controller locks the first classification for a short gesture window so one swipe cannot
 * alternate between pan and zoom as momentum grows.
 */
export function classifyWheelGesture(
  event: Pick<WheelEvent, 'ctrlKey' | 'deltaMode' | 'deltaX' | 'deltaY' | 'shiftKey'>,
): WheelGesture {
  if (event.ctrlKey) return 'zoom';
  if (event.shiftKey || Math.abs(event.deltaX) > 0) return 'pan';
  if (event.deltaMode === 0 && Math.abs(event.deltaY) < TRACKPAD_FIRST_DELTA_THRESHOLD) {
    return 'pan';
  }
  return 'zoom';
}

export class GraphCameraController {
  readonly #container: HTMLElement;
  readonly #port: CameraPort;
  readonly #controls: NavigationControls | undefined;
  readonly #transitionDurationMs: number;
  readonly #onMotionStart: () => void;
  readonly #onMotionEnd: (settleDurationMs: number) => void;
  readonly #onError: (() => void) | undefined;
  #gesture: { readonly kind: WheelGesture; readonly expiresAt: number } | undefined;
  #disposed = false;

  readonly #onControlsStart = (): void => {
    if (this.#disposed) return;
    this.#onMotionStart();
  };

  readonly #onControlsEnd = (): void => {
    if (this.#disposed) return;
    this.#onMotionEnd(50);
  };

  readonly #onWheel = (event: WheelEvent): void => {
    if (this.#disposed) return;
    event.preventDefault();

    const time = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
    const kind =
      event.ctrlKey || this.#gesture === undefined || time > this.#gesture.expiresAt
        ? classifyWheelGesture(event)
        : this.#gesture.kind;
    this.#gesture = { kind, expiresAt: time + TRACKPAD_GESTURE_WINDOW_MS };

    this.#runUserAction(() => {
      if (kind === 'zoom') {
        const pixelDelta = normalizeWheelDelta(event, this.#container.clientHeight);
        this.#zoomBy(Math.exp(clamp(pixelDelta, -600, 600) * WHEEL_ZOOM_SPEED), 0);
        return;
      }
      this.#panBy(
        normalizeWheelAxis(event.deltaX, event.deltaMode, this.#container.clientWidth),
        normalizeWheelAxis(event.deltaY, event.deltaMode, this.#container.clientHeight),
      );
    }, TRACKPAD_GESTURE_WINDOW_MS);
  };

  public constructor(container: HTMLElement, port: CameraPort, options: CameraControllerOptions) {
    this.#container = container;
    this.#port = port;
    this.#controls = asNavigationControls(options.controls);
    this.#transitionDurationMs = options.transitionDurationMs ?? DEFAULT_TRANSITION_MS;
    this.#onMotionStart = options.onMotionStart;
    this.#onMotionEnd = options.onMotionEnd;
    this.#onError = options.onError;

    if (this.#controls !== undefined) {
      this.#controls.enablePan = true;
      this.#controls.enableRotate = true;
      // OrbitControls otherwise consumes every wheel event as zoom, including trackpad swipes.
      this.#controls.enableZoom = false;
      this.#controls.screenSpacePanning = true;
      this.#controls.minDistance = MIN_CAMERA_DISTANCE;
      this.#controls.maxDistance = MAX_CAMERA_DISTANCE;
      this.#controls.addEventListener?.('start', this.#onControlsStart);
      this.#controls.addEventListener?.('end', this.#onControlsEnd);
    }

    this.#container.addEventListener('wheel', this.#onWheel, {
      capture: true,
      passive: false,
    });
  }

  public zoomIn(): void {
    this.#runUserAction(
      () => this.#zoomBy(TOOLBAR_ZOOM_IN_FACTOR, this.#transitionDurationMs),
      this.#transitionDurationMs,
    );
  }

  public zoomOut(): void {
    this.#runUserAction(
      () => this.#zoomBy(TOOLBAR_ZOOM_OUT_FACTOR, this.#transitionDurationMs),
      this.#transitionDurationMs,
    );
  }

  public fitGraph(): void {
    this.#runUserAction(
      () => this.#port.fitGraph(this.#transitionDurationMs, FIT_PADDING_PIXELS),
      this.#transitionDurationMs,
    );
  }

  public resetCamera(): void {
    this.#runUserAction(() => {
      const position = finiteCoordinates(this.#port.getPosition());
      const target = finiteCoordinates(this.#port.getTarget());
      const distance = clamp(
        vectorLength(subtract(position, target)) || DEFAULT_CAMERA_DISTANCE,
        MIN_CAMERA_DISTANCE,
        MAX_CAMERA_DISTANCE,
      );
      this.#port.moveTo({ x: 0, y: 0, z: distance }, ZERO, this.#transitionDurationMs);
    }, this.#transitionDurationMs);
  }

  public focus(targetValue: CameraCoordinates, distance = 80): void {
    this.#runUserAction(() => {
      const target = finiteCoordinates(targetValue);
      const camera = finiteCoordinates(this.#port.getPosition());
      const currentTarget = finiteCoordinates(this.#port.getTarget());
      const direction = normalize(subtract(camera, currentTarget), { x: 0, y: 0, z: 1 });
      const boundedDistance = clamp(distance, MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE);
      this.#port.moveTo(
        add(target, scale(direction, boundedDistance)),
        target,
        this.#transitionDurationMs,
      );
    }, this.#transitionDurationMs);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#container.removeEventListener('wheel', this.#onWheel, true);
    this.#controls?.removeEventListener?.('start', this.#onControlsStart);
    this.#controls?.removeEventListener?.('end', this.#onControlsEnd);
  }

  #zoomBy(factor: number, transitionDurationMs: number): void {
    const position = finiteCoordinates(this.#port.getPosition());
    const target = finiteCoordinates(this.#port.getTarget());
    const offset = subtract(position, target);
    const currentDistance = vectorLength(offset);
    const direction = normalize(offset, { x: 0, y: 0, z: 1 });
    const nextDistance = clamp(
      (currentDistance || DEFAULT_CAMERA_DISTANCE) * factor,
      MIN_CAMERA_DISTANCE,
      MAX_CAMERA_DISTANCE,
    );
    this.#port.moveTo(add(target, scale(direction, nextDistance)), target, transitionDurationMs);
  }

  #panBy(deltaX: number, deltaY: number): void {
    if (deltaX === 0 && deltaY === 0) return;
    const position = finiteCoordinates(this.#port.getPosition());
    const target = finiteCoordinates(this.#port.getTarget());
    const forward = normalize(subtract(target, position), { x: 0, y: 0, z: -1 });
    const right = normalize(cross(forward, WORLD_UP), { x: 1, y: 0, z: 0 });
    const up = normalize(cross(right, forward), WORLD_UP);
    const distance = vectorLength(subtract(position, target)) || DEFAULT_CAMERA_DISTANCE;
    const viewportHeight = Math.max(1, this.#container.clientHeight);
    const worldUnitsPerPixel =
      (2 * distance * Math.tan(DEFAULT_VERTICAL_FIELD_OF_VIEW_RADIANS / 2)) / viewportHeight;
    const translation = add(
      scale(right, deltaX * worldUnitsPerPixel),
      scale(up, -deltaY * worldUnitsPerPixel),
    );
    this.#port.moveTo(add(position, translation), add(target, translation), 0);
  }

  #runUserAction(action: () => void, settleDurationMs: number): void {
    if (this.#disposed) return;
    try {
      this.#onMotionStart();
      action();
      this.#onMotionEnd(settleDurationMs);
    } catch {
      this.#onError?.();
    }
  }
}

const ZERO: CameraCoordinates = { x: 0, y: 0, z: 0 };
const WORLD_UP: CameraCoordinates = { x: 0, y: 1, z: 0 };

function asNavigationControls(value: object | undefined): NavigationControls | undefined {
  return value === undefined ? undefined : (value as NavigationControls);
}

function normalizeWheelDelta(event: WheelEvent, pageSize: number): number {
  return normalizeWheelAxis(event.deltaY, event.deltaMode, pageSize);
}

function normalizeWheelAxis(delta: number, deltaMode: number, pageSize: number): number {
  if (!Number.isFinite(delta)) return 0;
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * Math.max(1, pageSize);
  return delta;
}

function finiteCoordinates(value: CameraCoordinates): CameraCoordinates {
  return {
    x: finiteNumber(value.x),
    y: finiteNumber(value.y),
    z: finiteNumber(value.z),
  };
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function add(left: CameraCoordinates, right: CameraCoordinates): CameraCoordinates {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left: CameraCoordinates, right: CameraCoordinates): CameraCoordinates {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(value: CameraCoordinates, factor: number): CameraCoordinates {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function cross(left: CameraCoordinates, right: CameraCoordinates): CameraCoordinates {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function vectorLength(value: CameraCoordinates): number {
  return Math.hypot(value.x, value.y, value.z);
}

function normalize(value: CameraCoordinates, fallback: CameraCoordinates): CameraCoordinates {
  const length = vectorLength(value);
  return length === 0 ? fallback : scale(value, 1 / length);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
