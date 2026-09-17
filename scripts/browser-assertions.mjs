import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '')

const baseUrl = process.env.GOLEM_BROWSER_URL ?? 'http://127.0.0.1:3000/'
const screenshotPrefix = process.env.GOLEM_BROWSER_SCREENSHOT ?? '.artifacts/browser'
const expectedPlaceholder = process.env.GOLEM_EXPECTED_PLACEHOLDER ?? 'Message the agent…'
let browser

try {
  browser = await chromium.launch({
    executablePath: process.env.GOLEM_BROWSER_EXECUTABLE || undefined,
    headless: true,
    args: ['--no-sandbox'],
  })
  for (const [name, width, height] of [['desktop', 1280, 900], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: 'Enter build mode' }).click()
      await page.locator(`textarea[placeholder="${expectedPlaceholder}"]`).waitFor({ state: 'visible' })
      const result = await page.evaluate(() => {
        const shell = document.querySelector('[data-golem-component="Shell"]')
        const chat = document.querySelector('[data-golem-component="Chat"]')
        const aside = document.querySelector('aside')
        const box = (node) => { const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height } }
        return {
          layout: shell.dataset.layout,
          font: getComputedStyle(document.body).fontFamily,
          shellDisplay: getComputedStyle(shell).display,
          chatDisplay: getComputedStyle(chat).display,
          chat: box(chat),
          aside: aside && box(aside),
        }
      })
      assert.match(result.font, /-apple-system|Segoe UI|sans-serif/)
      assert.equal(result.shellDisplay, 'flex')
      assert.equal(result.chatDisplay, 'flex')
      assert.ok(result.chat.width > 0 && result.chat.height > 100)
      if (name === 'desktop') {
        assert.equal(result.layout, 'desktop')
        assert.ok(result.aside.width >= 300 && result.aside.width <= 321)
        assert.ok(Math.abs(result.chat.width - result.aside.width) < 2)
      } else {
        assert.equal(result.layout, 'mobile')
        assert.equal(result.aside, null)
        assert.equal(result.chat.width, width)
        await page.getByRole('tab', { name: 'canvas' }).click()
        const canvas = page.locator('[data-golem-component="Shell"] section')
        await canvas.waitFor({ state: 'visible' })
        assert.equal(await canvas.evaluate((node) => node.getBoundingClientRect().width), width)
      }
      await page.screenshot({ path: `${screenshotPrefix}-${name}.png`, fullPage: true })
      console.log(name, JSON.stringify(result))
    } finally {
      await page.close()
    }
  }
} finally {
  await browser?.close()
}
