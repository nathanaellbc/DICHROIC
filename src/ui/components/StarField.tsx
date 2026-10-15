/**
 * Bintang-bintang kecil yang berkelip halus di latar layar sambutan. Posisi,
 * ukuran, dan ritme kelip tetap (deret kuasi-acak), jadi tidak berubah tiap
 * render; animasinya CSS murni (opacity/transform), mati saat Reduce Motion.
 * Data yang sama dipakai IntroBackdrop untuk menggambar ulang bintang di
 * kanvas latar kaca.
 */

const COUNT = 64;

// Deret Halton (basis 2 dan 3): tersebar rata tanpa menggerombol.
const halton = (n: number, b: number) => { let f = 1, r = 0; for (let k = n; k > 0; k = Math.floor(k / b)) { f /= b; r += f * (k % b); } return r; };

/** x, y dalam persen panggung; size px; duration/delay detik; dim = opacity puncak. */
export const STARS = Array.from({ length: COUNT }, (_, i) => {
  const big = i % 9 === 0;
  return {
    x: halton(i + 1, 2) * 100, y: halton(i + 1, 3) * 100,
    size: big ? 2.4 : 1 + (i % 3) * 0.45,
    duration: 3.2 + ((i * 7) % 11) * 0.45,
    delay: -((i * 13) % 17) * 0.4,
    dim: 0.25 + ((i * 5) % 7) * 0.08,
  };
});

export function StarField() {
  return (
    <div className="intro-stars" aria-hidden="true">
      {STARS.map((s, i) => (
        <span
          key={i}
          className="intro-star"
          style={{
            left: `${s.x}%`, top: `${s.y}%`, width: s.size, height: s.size,
            animationDuration: `${s.duration}s`, animationDelay: `${s.delay}s`,
            ['--star-dim' as string]: s.dim,
          }}
        />
      ))}
    </div>
  );
}
