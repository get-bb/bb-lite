import { expect, it } from "vitest";
import {
  closeComposerPopup,
  openComposerPopup,
  openComposerPopupId,
  subscribeComposerPopups,
} from "../app/lib/composer-popups";

it("keeps one open popup per composer and notifies on change", () => {
  let notified = 0;
  const stop = subscribeComposerPopups(() => notified++);
  openComposerPopup("thread:a", "picker");
  openComposerPopup("thread:a", "picker");
  openComposerPopup("thread:b", "other");
  expect(openComposerPopupId("thread:a")).toBe("picker");
  expect(openComposerPopupId("thread:b")).toBe("other");
  closeComposerPopup("thread:a", "stale");
  expect(openComposerPopupId("thread:a")).toBe("picker");
  openComposerPopup("thread:a", "next");
  closeComposerPopup("thread:a");
  expect(openComposerPopupId("thread:a")).toBeNull();
  expect(notified).toBe(4);
  stop();
  closeComposerPopup("thread:b");
  expect(notified).toBe(4);
});
