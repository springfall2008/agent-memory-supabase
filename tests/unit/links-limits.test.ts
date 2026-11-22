import { assertThrows } from '@std/assert';
import { checkDepth, StoreError } from '../../supabase/functions/_shared/limits.ts';

Deno.test('checkDepth accepts 1..3 integers only', () => {
  checkDepth(1);
  checkDepth(3);
  for (const bad of [0, 4, 1.5, -1, Number.NaN]) {
    assertThrows(() => checkDepth(bad), StoreError, 'depth must be between 1 and 3');
  }
});
