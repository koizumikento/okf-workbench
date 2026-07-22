import { describe, expect, it } from 'vitest';

import {
  BUNDLE_UNAVAILABLE_NOTIFICATION,
  RuntimeAvailabilityNotificationState,
} from '../../../src/extension/runtimeAvailabilityNotifications.js';

describe('runtime availability notifications', () => {
  const root = 'memfs://workspace/knowledge';

  it('describes the unavailable/read-permission condition and two retry paths', () => {
    expect(BUNDLE_UNAVAILABLE_NOTIFICATION).toContain('unavailable');
    expect(BUNDLE_UNAVAILABLE_NOTIFICATION).toContain('read permissions');
    expect(BUNDLE_UNAVAILABLE_NOTIFICATION).toContain('save a Markdown file');
    expect(BUNDLE_UNAVAILABLE_NOTIFICATION).toContain('OKF: Validate Bundle');
    expect(BUNDLE_UNAVAILABLE_NOTIFICATION).not.toContain(root);
  });

  it('allows one warning per outage and resets only after a successful publication', () => {
    const notifications = new RuntimeAvailabilityNotificationState();

    expect(notifications.shouldNotifyFailure(root)).toBe(true);
    expect(notifications.shouldNotifyFailure(root)).toBe(false);
    expect(notifications.shouldNotifyFailure(root)).toBe(false);

    expect(notifications.recordPublication(root)).toBe(true);
    expect(notifications.recordPublication(root)).toBe(false);
    expect(notifications.shouldNotifyFailure(root)).toBe(true);
  });

  it('starts a fresh bounded notification window when the selection changes or clears', () => {
    const notifications = new RuntimeAvailabilityNotificationState();
    const otherRoot = 'memfs://workspace/other';

    expect(notifications.shouldNotifyFailure(root)).toBe(true);
    expect(notifications.shouldNotifyFailure(otherRoot)).toBe(true);
    expect(notifications.shouldNotifyFailure(otherRoot)).toBe(false);

    notifications.clear();
    expect(notifications.shouldNotifyFailure(root)).toBe(true);
  });
});
