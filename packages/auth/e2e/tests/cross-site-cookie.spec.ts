import { test, expect, type Page } from '@playwright/test';

test.describe('Cross-Site Cookie Behavior', () => {
  const createUserAndLogin = async (page: Page, timestamp: number) => {
    const rand = Math.random().toString(36).slice(2, 8);
    const username = `xsite${timestamp}${rand}`;
    const email = `xsite${timestamp}${rand}@example.com`;
    const password = 'CrossSitePwd123';

    await page.goto('/');
    await page.fill('#username', username);
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.click('#submit-btn');
    await expect(page.locator('.dashboard')).toBeVisible();

    return { username, email, password };
  };

  test('should preserve auth cookie when navigating via link from external site (sameSite=Lax)', async ({ page }) => {
    const timestamp = Date.now();
    const { username } = await createUserAndLogin(page, timestamp);

    // Verify we're logged in
    await expect(page.locator('.welcome-card h2')).toContainText(`Welcome, ${username}`);

    // Navigate to the API server (different port = different origin)
    // This simulates being on an external website
    await page.goto('http://localhost:3457');

    // Inject a link pointing back to our app and click it
    // This simulates a user clicking a link on an external site
    await page.evaluate(() => {
      document.body.innerHTML = '<a id="back-link" href="http://localhost:3456">Go to app</a>';
    });
    await page.click('#back-link');

    // Wait for the app to load
    await page.waitForURL('http://localhost:3456/**');

    // With sameSite=Lax, the cookie should be sent on this top-level navigation
    // so the user should still be authenticated
    await expect(page.locator('.dashboard')).toBeVisible();
    await expect(page.locator('.welcome-card h2')).toContainText(`Welcome, ${username}`);
  });

  test('should preserve auth cookie on redirect from external site', async ({ page }) => {
    const timestamp = Date.now();
    const { username } = await createUserAndLogin(page, timestamp);

    // Navigate to external origin (API server)
    await page.goto('http://localhost:3457');

    // Simulate a redirect back via JavaScript (like an OAuth callback redirect)
    await page.evaluate(() => {
      window.location.href = 'http://localhost:3456';
    });

    await page.waitForURL('http://localhost:3456/**');

    // User should still be authenticated after cross-origin redirect
    await expect(page.locator('.dashboard')).toBeVisible();
    await expect(page.locator('.welcome-card h2')).toContainText(`Welcome, ${username}`);
  });

  test('should preserve auth cookie when using window.open from external site', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const timestamp = Date.now();
    const { username } = await createUserAndLogin(page, timestamp);

    // Navigate to external origin
    await page.goto('http://localhost:3457');

    // Open our app in a new tab from the external site (simulates target="_blank" link)
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.evaluate(() => {
        window.open('http://localhost:3456', '_blank');
      }),
    ]);

    await newPage.waitForLoadState();

    // The new tab should have the auth cookie (sameSite=Lax allows top-level navigations)
    await expect(newPage.locator('.dashboard')).toBeVisible();
    await expect(newPage.locator('.welcome-card h2')).toContainText(`Welcome, ${username}`);

    await context.close();
  });
});
