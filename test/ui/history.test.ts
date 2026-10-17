import { describe, expect, it } from 'vitest';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import { describeChange } from '../../src/ui/model/history';

const base = BASELINE_RENDER_PARAMS;

describe('describeChange (riwayat Undo)', () => {
  it('names the tool and its new value', () => {
    expect(describeChange(base, { ...base, printExposureEv: 0.5 })).toEqual({ label: 'Exposure', value: '−0.5 EV' });
  });

  it('names film and paper by stock', () => {
    expect(describeChange(base, { ...base, film: 'kodak_portra_800' })).toEqual({ label: 'Film', value: 'Portra 800' });
    expect(describeChange(base, { ...base, filmEnabled: false })).toEqual({ label: 'Film', value: 'Off' });
    expect(describeChange(base, { ...base, paper: 'kodak_2383' }).label).toBe('Paper');
  });

  it('groups white balance fields into one tool', () => {
    const r = describeChange(base, { ...base, cameraWhiteBalanceK: 6500, cameraTint: 0.2 });
    expect(r.label).toBe('White Balance');
  });

  it('lists several tools without a single value', () => {
    const r = describeChange(base, { ...base, printExposureEv: 0.5, film: 'kodak_portra_800', paper: 'kodak_2383' });
    expect(r.value).toBeUndefined();
    expect(r.label).toMatch(/\+1$/);
  });
});
