import { describe, expect, it, vi } from 'vitest';

import {
  classifyWheelGesture,
  GraphCameraController,
  type CameraCoordinates,
  type CameraPort,
} from '../../../src/webview/graph/camera-controller.js';

class FakeContainer {
  public readonly clientWidth = 800;
  public readonly clientHeight = 600;
  readonly #listeners = new Map<string, EventListener>();

  public addEventListener(type: string, listener: EventListener): void {
    this.#listeners.set(type, listener);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    if (this.#listeners.get(type) === listener) this.#listeners.delete(type);
  }

  public dispatchWheel(
    values: Partial<
      Pick<WheelEvent, 'ctrlKey' | 'deltaMode' | 'deltaX' | 'deltaY' | 'shiftKey' | 'timeStamp'>
    >,
  ): ReturnType<typeof createWheelEvent> {
    const event = createWheelEvent(values);
    this.#listeners.get('wheel')?.(event as unknown as Event);
    return event;
  }
}

class FakeControls {
  public enablePan = false;
  public enableRotate = false;
  public enableZoom = true;
  public maxDistance = 0;
  public minDistance = 0;
  public screenSpacePanning = false;
  public readonly target = { x: 0, y: 0, z: 0 };
  readonly #listeners = new Map<string, () => void>();

  public addEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, listener);
  }

  public removeEventListener(type: string, listener: () => void): void {
    if (this.#listeners.get(type) === listener) this.#listeners.delete(type);
  }

  public dispatch(type: 'end' | 'start'): void {
    this.#listeners.get(type)?.();
  }
}

function createPort(): CameraPort & {
  readonly fits: { readonly duration: number; readonly padding: number }[];
  readonly moves: {
    readonly position: CameraCoordinates;
    readonly target: CameraCoordinates;
    readonly duration: number;
  }[];
} {
  let position: CameraCoordinates = { x: 0, y: 0, z: 100 };
  let target: CameraCoordinates = { x: 0, y: 0, z: 0 };
  const moves: {
    position: CameraCoordinates;
    target: CameraCoordinates;
    duration: number;
  }[] = [];
  const fits: { duration: number; padding: number }[] = [];
  return {
    moves,
    fits,
    getPosition: () => position,
    getTarget: () => target,
    moveTo: (nextPosition, nextTarget, duration) => {
      position = nextPosition;
      target = nextTarget;
      moves.push({ position: nextPosition, target: nextTarget, duration });
    },
    fitGraph: (duration, padding) => fits.push({ duration, padding }),
  };
}

describe('GraphCameraController', () => {
  it('classifies identifiable pinch, trackpad, and mouse-wheel input', () => {
    expect(
      classifyWheelGesture({
        ctrlKey: true,
        shiftKey: false,
        deltaMode: 0,
        deltaX: 0,
        deltaY: -4,
      }),
    ).toBe('zoom');
    expect(
      classifyWheelGesture({
        ctrlKey: false,
        shiftKey: false,
        deltaMode: 0,
        deltaX: 3,
        deltaY: 12,
      }),
    ).toBe('pan');
    expect(
      classifyWheelGesture({
        ctrlKey: false,
        shiftKey: false,
        deltaMode: 0,
        deltaX: 0,
        deltaY: 7,
      }),
    ).toBe('pan');
    expect(
      classifyWheelGesture({
        ctrlKey: false,
        shiftKey: false,
        deltaMode: 1,
        deltaX: 0,
        deltaY: 3,
      }),
    ).toBe('zoom');
  });

  it('configures orbit controls and keeps the render loop bounded around pointer motion', () => {
    const container = new FakeContainer();
    const controls = new FakeControls();
    const onMotionStart = vi.fn();
    const onMotionEnd = vi.fn();
    const controller = new GraphCameraController(
      container as unknown as HTMLElement,
      createPort(),
      {
        controls,
        onMotionStart,
        onMotionEnd,
      },
    );

    expect(controls).toMatchObject({
      enablePan: true,
      enableRotate: true,
      enableZoom: false,
      screenSpacePanning: true,
      minDistance: 16,
      maxDistance: 4_096,
    });
    controls.dispatch('start');
    controls.dispatch('end');
    expect(onMotionStart).toHaveBeenCalledOnce();
    expect(onMotionEnd).toHaveBeenCalledWith(50);

    controller.dispose();
    controls.dispatch('start');
    expect(onMotionStart).toHaveBeenCalledOnce();
  });

  it('maps wheel, swipe, and pinch gestures without allowing page scroll', () => {
    const container = new FakeContainer();
    const port = createPort();
    const onMotionStart = vi.fn();
    const onMotionEnd = vi.fn();
    const controller = new GraphCameraController(container as unknown as HTMLElement, port, {
      controls: new FakeControls(),
      onMotionStart,
      onMotionEnd,
    });

    const wheel = container.dispatchWheel({
      deltaMode: 0,
      deltaY: 120,
      timeStamp: 10,
    });
    expect(wheel.preventDefault).toHaveBeenCalledOnce();
    expect(port.moves.at(-1)?.position.z).toBeGreaterThan(100);

    const cameraBeforePan = port.moves.at(-1)?.position;
    const pan = container.dispatchWheel({
      deltaMode: 0,
      deltaX: 12,
      deltaY: 8,
      timeStamp: 500,
    });
    const cameraAfterPan = port.moves.at(-1)?.position;
    expect(pan.preventDefault).toHaveBeenCalledOnce();
    expect(cameraAfterPan).not.toEqual(cameraBeforePan);
    expect(port.moves.at(-1)?.target).not.toEqual({ x: 0, y: 0, z: 0 });

    const distanceBeforePinch = distance(port.moves.at(-1)?.position, port.moves.at(-1)?.target);
    container.dispatchWheel({
      ctrlKey: true,
      deltaMode: 0,
      deltaY: -30,
      timeStamp: 1_000,
    });
    const distanceAfterPinch = distance(port.moves.at(-1)?.position, port.moves.at(-1)?.target);
    expect(distanceAfterPinch).toBeLessThan(distanceBeforePinch);
    expect(onMotionStart).toHaveBeenCalledTimes(3);
    expect(onMotionEnd).toHaveBeenLastCalledWith(180);

    controller.dispose();
  });

  it('routes toolbar, fit, reset, and node focus through the camera port', () => {
    const port = createPort();
    const controller = new GraphCameraController(
      new FakeContainer() as unknown as HTMLElement,
      port,
      {
        controls: new FakeControls(),
        transitionDurationMs: 400,
        onMotionStart: vi.fn(),
        onMotionEnd: vi.fn(),
      },
    );

    controller.zoomIn();
    expect(port.moves.at(-1)).toMatchObject({ duration: 400 });
    expect(port.moves.at(-1)?.position.z).toBeCloseTo(78);
    controller.zoomOut();
    expect(port.moves.at(-1)?.position.z).toBeCloseTo(99.84);

    controller.fitGraph();
    expect(port.fits).toEqual([{ duration: 400, padding: 48 }]);

    controller.focus({ x: 10, y: 20, z: 30 }, 80);
    expect(port.moves.at(-1)).toMatchObject({
      target: { x: 10, y: 20, z: 30 },
      duration: 400,
    });

    controller.resetCamera();
    expect(port.moves.at(-1)).toMatchObject({
      position: { x: 0, y: 0 },
      target: { x: 0, y: 0, z: 0 },
      duration: 400,
    });

    controller.dispose();
  });
});

function createWheelEvent(
  values: Partial<
    Pick<WheelEvent, 'ctrlKey' | 'deltaMode' | 'deltaX' | 'deltaY' | 'shiftKey' | 'timeStamp'>
  >,
): {
  readonly ctrlKey: boolean;
  readonly deltaMode: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly preventDefault: ReturnType<typeof vi.fn>;
  readonly shiftKey: boolean;
  readonly timeStamp: number;
} {
  return {
    ctrlKey: values.ctrlKey ?? false,
    shiftKey: values.shiftKey ?? false,
    deltaMode: values.deltaMode ?? 0,
    deltaX: values.deltaX ?? 0,
    deltaY: values.deltaY ?? 0,
    timeStamp: values.timeStamp ?? 0,
    preventDefault: vi.fn(),
  };
}

function distance(
  left: CameraCoordinates | undefined,
  right: CameraCoordinates | undefined,
): number {
  if (left === undefined || right === undefined) return Number.NaN;
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
