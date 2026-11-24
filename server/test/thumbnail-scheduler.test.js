import test from "node:test";
import assert from "node:assert/strict";
import { hourInWindow, localHourAt, resolveThumbnailSchedule } from "../src/thumbnail-scheduler.ts";

test("跨午夜的夜间时段包含起点、不包含终点", () => {
  assert.equal(hourInWindow(22, 22, 8), true);
  assert.equal(hourInWindow(2, 22, 8), true);
  assert.equal(hourInWindow(8, 22, 8), false);
  assert.equal(hourInWindow(15, 22, 8), false);
});

test("同一天内的时段按半开区间判断", () => {
  assert.equal(hourInWindow(9, 9, 18), true);
  assert.equal(hourInWindow(17, 9, 18), true);
  assert.equal(hourInWindow(18, 9, 18), false);
});

test("按配置时区选择昼夜并发", () => {
  const date = new Date("2026-11-13T15:00:00.000Z");
  assert.equal(localHourAt(date, "Asia/Shanghai"), 23);
  assert.deepEqual(resolveThumbnailSchedule({
    globallyPaused: false,
    daytimeConcurrency: 2,
    nighttimeConcurrency: 8,
    nightStartHour: 22,
    nightEndHour: 8,
    timeZone: "Asia/Shanghai",
  }, date), {
    globallyPaused: false,
    timeZone: "Asia/Shanghai",
    localHour: 23,
    isNight: true,
    period: "night",
    concurrency: 8,
  });
});

test("无效时区回退到 Asia/Shanghai", () => {
  const date = new Date("2026-11-13T01:00:00.000Z");
  assert.equal(localHourAt(date, "invalid/time-zone"), 9);
});
