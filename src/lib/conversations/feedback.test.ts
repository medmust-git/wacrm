import { describe, expect, it } from 'vitest'
import { shouldAskForFeedback } from './feedback'

const NOW = Date.parse('2026-09-14T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

describe('shouldAskForFeedback', () => {
  it('asks when staff just helped a customer who wrote recently', () => {
    expect(
      shouldAskForFeedback({ previousStatus: 'open', nextStatus: 'closed', lastAgentMessageAt: hoursAgo(1), lastCustomerMessageAt: hoursAgo(2), now: NOW }),
    ).toBe(true)
  })

  it('does not ask for a chat no person took part in', () => {
    expect(
      shouldAskForFeedback({ previousStatus: 'pending', nextStatus: 'closed', lastAgentMessageAt: null, lastCustomerMessageAt: hoursAgo(1), now: NOW }),
    ).toBe(false)
  })

  it('does not ask outside the window a free-form message can be delivered in', () => {
    expect(
      shouldAskForFeedback({ previousStatus: 'open', nextStatus: 'closed', lastAgentMessageAt: hoursAgo(1), lastCustomerMessageAt: hoursAgo(23.5), now: NOW }),
    ).toBe(false)
  })

  it('does not ask twice, or on any other status change', () => {
    const recent = { lastAgentMessageAt: hoursAgo(1), lastCustomerMessageAt: hoursAgo(1), now: NOW }
    expect(shouldAskForFeedback({ ...recent, previousStatus: 'closed', nextStatus: 'closed' })).toBe(false)
    expect(shouldAskForFeedback({ ...recent, previousStatus: 'open', nextStatus: 'pending' })).toBe(false)
  })
})
