import { describe, expect, it } from 'vitest';
import { percentInputToRate, rateToPercentInput } from './format';

describe('百分比欄位換算', () => {
  it('比例轉成百分比字串時沒有浮點數尾巴', () => {
    // 0.07 * 100 在 JS 會變成 7.000000000000001
    expect(rateToPercentInput(0.07)).toBe('7');
    expect(rateToPercentInput('0.29')).toBe('29');
    expect(rateToPercentInput(0.125)).toBe('12.5');
    expect(rateToPercentInput(0)).toBe('0');
    expect(rateToPercentInput(null)).toBe('');
  });

  it('百分比字串轉回比例字串；空白回傳 null', () => {
    expect(percentInputToRate('7')).toBe('0.07');
    expect(percentInputToRate('12.5')).toBe('0.125');
    expect(percentInputToRate(' 35 ')).toBe('0.35');
    expect(percentInputToRate('')).toBeNull();
    expect(percentInputToRate('.')).toBeNull();
  });
});
