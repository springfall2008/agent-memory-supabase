import { assertEquals, assertThrows } from '@std/assert';
import { checkClaimMinutes, snippet, StoreError } from '../../supabase/functions/_shared/limits.ts';

Deno.test('checkClaimMinutes accepts 1 to 5256000 whole minutes only', () => {
  checkClaimMinutes(1);
  checkClaimMinutes(5_256_000);
  for (const bad of [0, 5_256_001, 1.5, -1, Number.NaN]) {
    assertThrows(() => checkClaimMinutes(bad), StoreError, 'minutes must be between 1 and 5256000');
  }
});

Deno.test('snippet keeps short text whole and cuts long text with an ellipsis', () => {
  assertEquals(snippet('short', 10), 'short');
  assertEquals(snippet('x'.repeat(12), 10), 'x'.repeat(10) + '…');
});
