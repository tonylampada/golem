import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeCron } from '../src/browser/cron.ts'

test('describeCron: common shapes in words, anything else left to the raw cron', () => {
  assert.equal(describeCron('0 6 * * *'), 'every day at 06:00')
  assert.equal(describeCron('30 8,17 * * *'), 'every day at 08:30, 17:30')
  assert.equal(describeCron('0 9 * * 1-5'), 'weekdays at 09:00')
  assert.equal(describeCron('15 7 * * 1,3'), 'every Monday, Wednesday at 07:15')
  assert.equal(describeCron('0 0 1 * *'), 'every month on day 1 at 00:00')
  assert.equal(describeCron('*/15 * * * *'), 'every 15 minutes')
  assert.equal(describeCron('5 * * * *'), 'every hour at :05')
  assert.equal(describeCron('0 */6 * * *'), 'every 6 hours at :00')
  assert.equal(describeCron('0 6 * 1 *'), undefined)
  assert.equal(describeCron('0 6-9 * * *'), undefined)
  assert.equal(describeCron('nonsense'), undefined)
})
