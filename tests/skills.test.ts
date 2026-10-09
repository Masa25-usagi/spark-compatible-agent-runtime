import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { SkillRegistry } from '../src/runtime/registries.js';
import { FixedClock } from '../src/shared/clock.js';
import { SQLiteStore } from '../src/storage/sqlite.js';

describe('Persistent SkillRegistry', () => {
  it('creates, updates, disables, enables, lists, and deletes skills', () => {
    const clock = new FixedClock(new Date('2026-07-18T00:00:00.000Z'));
    const store = new SQLiteStore(':memory:', { clock });
    try {
      const skills = new SkillRegistry(store, clock);
      skills.register({ name: ' inbox ', description: ' Review mail ', instructions: 'Read only' });
      assert.equal(skills.get('inbox')?.description, 'Review mail');
      assert.equal(skills.listRecords()[0]?.enabled, true);
      assert.equal(
        skills.update('inbox', { description: 'Review inbox', instructions: 'Summarize' })
          .instructions,
        'Summarize',
      );
      assert.equal(skills.setEnabled('inbox', false).enabled, false);
      assert.equal(skills.get('inbox'), null);
      assert.equal(skills.listRecords().length, 1);
      assert.equal(skills.setEnabled('inbox', true).enabled, true);
      assert.equal(skills.remove('inbox'), true);
      assert.equal(skills.listRecords().length, 0);
    } finally {
      store.close();
    }
  });
});
