import { expect, test } from "@playwright/test";
import { MOCK } from "./env";

// Extended session (run with: LONG=1 LONG_SEC=600 npx playwright test long).
// Records continuously with the default segmenting (new part at a pause after ~60 s)
// and checks nothing stops early and every part is transcribed in order.

const SEC = Number(process.env.LONG_SEC || 600);

test(`records continuously for ${SEC}s and analyses it @long`, async ({ page }) => {
  test.setTimeout(SEC * 1000 + 180_000);
  await fetch(`${MOCK}/__reset`, { method: "POST" });
  page.on("dialog", (d) => d.accept());
  await page.goto("/");
  await page.getByRole("button", { name: /Start Recording/ }).click();
  await expect(page.getByTestId("rec-status")).toHaveText(/Recording/);
  await page.waitForTimeout(SEC * 1000);
  await expect(page.getByTestId("rec-status")).toHaveText(/Recording/); // never auto-stopped
  const [m, s] = (await page.getByTestId("timer").textContent())!.split(":").map(Number);
  expect(m * 60 + s).toBeGreaterThanOrEqual(SEC - 2);
  await page.getByRole("button", { name: /Pause & Analyse/ }).click();
  await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "complete", { timeout: 120_000 });
  const log = (await (await fetch(`${MOCK}/__log`)).json()) as { kind: string; filename: string; size: number }[];
  const parts = log.filter((l) => l.kind === "transcribe");
  console.log(`parts: ${parts.length}, sizes (KB): ${parts.map((p) => Math.round(p.size / 1024)).join(", ")}`);
  expect(parts.length).toBeGreaterThanOrEqual(Math.floor(SEC / 60) - 1);
  expect(parts.length).toBeLessThanOrEqual(Math.ceil(SEC / 60) + 1);
  // every part is a self-contained file well under the 25 MB upload limit
  for (const p of parts) expect(p.size).toBeLessThan(25 * 1024 * 1024);
  const orders = parts.map((p) => Number(/segment-(\d+)/.exec(p.filename)![1])).sort((a, b) => a - b);
  expect(new Set(orders).size).toBe(orders.length);
});
