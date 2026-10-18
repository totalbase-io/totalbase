import { describe, expect, it } from 'vitest'
import { cronNameList, isValidCronExpression, MONTH_NAMES, WEEKDAY_NAMES } from './cron-expression'

describe('cron expressions on the client', () => {
  it('accepts numbers, names, lists, ranges and steps', () => {
    for (const expression of ['0 3 * * *', '*/15 9-17 * * MON-FRI', '0 3 1 JAN,JUL *', '0 0 * dec sun', '0 12 1-7 * 1', '0 0 * * 7', '30 6 * MAR-OCT/2 *']) {
      expect(isValidCronExpression(expression), expression).toBe(true)
    }
  })

  it('refuses names in the wrong field, unknown names and bad shapes', () => {
    for (const expression of ['0 3 * * JAN', '0 3 * MON *', '0 3 * * FUNDAY', '0 3 * *', '60 * * * *', '0 0 * * FRI-MON', '0 0 * * */0']) {
      expect(isValidCronExpression(expression), expression).toBe(false)
    }
  })

  it('writes a value list as names, runs of three or more as a range', () => {
    expect(cronNameList([1, 2, 3, 4, 5], WEEKDAY_NAMES, 0)).toBe('MON-FRI')
    expect(cronNameList([3, 1], WEEKDAY_NAMES, 0)).toBe('MON,WED')
    expect(cronNameList([0, 6], WEEKDAY_NAMES, 0)).toBe('SUN,SAT')
    expect(cronNameList([1, 7], MONTH_NAMES, 1)).toBe('JAN,JUL')
    expect(cronNameList([1, 2, 3, 6, 7, 12], MONTH_NAMES, 1)).toBe('JAN-MAR,JUN,JUL,DEC')
  })
})
