/** Nama tap kanonis, persis seperti implementasi referensi Python. */
export const Tap = {
  RGB_IN: 'rgb_in',
  RGB_PRE: 'rgb_pre',
  LOG_E_FILM: 'log_e_film',
  CMY_FILM: 'cmy_film',
  LOG_E_PRINT: 'log_e_print',
  CMY_PRINT: 'cmy_print',
  RGB_OUT: 'rgb_out',
} as const;

export type TapName = (typeof Tap)[keyof typeof Tap];

/** Urutan tap sepanjang pipeline, dari masukan ke keluaran. */
export const TAP_ORDER: readonly TapName[] = [
  Tap.RGB_IN,
  Tap.RGB_PRE,
  Tap.LOG_E_FILM,
  Tap.CMY_FILM,
  Tap.LOG_E_PRINT,
  Tap.CMY_PRINT,
  Tap.RGB_OUT,
];
