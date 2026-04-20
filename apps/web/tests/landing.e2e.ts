import { expect, test } from "@playwright/test";

test.describe("marketing pages", () => {
  test("home renders hero with value prop and primary CTA", async ({ page }) => {
    await page.goto("/");

    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toBeVisible();
    const h1Text = (await h1.textContent()) ?? "";
    expect(h1Text.toLowerCase()).toContain("prompts");

    const wordmark = page.getByRole("link", { name: /bematist home/i });
    await expect(wordmark).toBeVisible();

    const signIn = page.getByRole("link", { name: /sign in with github/i }).first();
    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveAttribute("href", "/auth/sign-in");
  });

  test("home has three feature cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Prompt outcomes" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Subscription vs API delta" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Per-developer clarity" })).toBeVisible();
  });

  test("install page renders curl command and supported tools", async ({ page }) => {
    await page.goto("/install");

    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toBeVisible();

    const curl = page.getByText(/curl -fsSL https:\/\/bematist\.up\.railway\.app\/install\.sh/);
    await expect(curl).toBeVisible();

    for (const tool of ["Claude Code", "Codex CLI", "Cursor"]) {
      await expect(page.getByText(tool, { exact: true }).first()).toBeVisible();
    }
  });
});
