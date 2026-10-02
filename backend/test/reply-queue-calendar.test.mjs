import test from 'node:test';
import assert from 'node:assert/strict';
import {periods,dayStart,monthEnd} from '../src/ongoing.mjs';

test('queue reset helpers use UTC through leap months and year rollover',()=>{
  for(const [at,day,nextMonth] of [
    ['2035-01-01T00:00:00Z','2035-01-01','2035-02-01T00:00:00Z'],
    ['2036-02-29T23:59:59Z','2036-02-29','2036-03-01T00:00:00Z'],
    ['2035-12-31T23:59:59Z','2035-12-31','2036-01-01T00:00:00Z']
  ]) {
    const now=Date.parse(at)/1000;
    assert.equal(periods(now).day,day);
    assert.equal(dayStart(now),Date.parse(day+'T00:00:00Z')/1000);
    assert.equal(monthEnd(now),Date.parse(nextMonth)/1000);
  }
});
