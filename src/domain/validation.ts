import type { DatePrecision } from './types';

export interface ValidatedVisitDate {
  value: string;
  precision: DatePrecision;
}

const DATE_ERROR = '日期无效';

export function validateVisitDate(value: string): ValidatedVisitDate {
  if (/^\d{4}$/.test(value)) {
    return { value, precision: 'year' };
  }

  const monthMatch = /^(\d{4})-(\d{2})$/.exec(value);
  if (monthMatch) {
    const month = Number(monthMatch[2]);
    if (month >= 1 && month <= 12) {
      return { value, precision: 'month' };
    }
    throw new Error(DATE_ERROR);
  }

  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!dayMatch) {
    throw new Error(DATE_ERROR);
  }

  const year = Number(dayMatch[1]);
  const month = Number(dayMatch[2]);
  const day = Number(dayMatch[3]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw new Error(DATE_ERROR);
  }
  return { value, precision: 'day' };
}

export function sanitizeNote(value: string): string {
  const note = value.trim();
  if ([...note].length > 500) {
    throw new Error('备注不能超过 500 个字符');
  }
  return note;
}
