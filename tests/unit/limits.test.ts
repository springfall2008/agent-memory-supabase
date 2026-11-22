import { assertEquals, assertThrows } from '@std/assert';
import {
  checkBrowseLimit,
  checkLimit,
  checkOffset,
  MAX_BROWSE_LIMIT,
  MAX_LIMIT,
  StoreError,
} from '../../supabase/functions/_shared/limits.ts';

Deno.test('ranked limits stay capped at 100 while browse limits go to 1000', () => {
  assertEquals(MAX_LIMIT, 100);
  assertEquals(MAX_BROWSE_LIMIT, 1000);
  checkLimit(100);
  assertThrows(() => checkLimit(101), StoreError, 'limit must be between 1 and 100');
});

Deno.test('checkBrowseLimit accepts 1..1000 integers only', () => {
  checkBrowseLimit(1);
  checkBrowseLimit(1000);
  for (const bad of [0, 1001, 2.5, -1, Number.NaN]) {
    assertThrows(() => checkBrowseLimit(bad), StoreError, 'limit must be between 1 and 1000');
  }
});

Deno.test('checkOffset accepts non-negative integers only', () => {
  checkOffset(0);
  checkOffset(5000);
  for (const bad of [-1, 1.5, Number.NaN]) {
    assertThrows(() => checkOffset(bad), StoreError, 'offset must be a non-negative integer');
  }
});
