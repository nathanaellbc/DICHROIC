/**
 * Decrypted Text (React Bits): animasi teks teracak (scramble/decrypt)
 * yang tersusun berurutan menjadi teks akhir.
 *
 * Mendukung preferensi reduce motion dan aksesibilitas pembaca layar (sr-only).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';

export interface DecryptedTextProps {
  text: string;
  speed?: number;
  maxIterations?: number;
  sequential?: boolean;
  revealDirection?: 'start' | 'end' | 'center';
  useOriginalCharsOnly?: boolean;
  characters?: string;
  className?: string;
  encryptedClassName?: string;
  parentClassName?: string;
  animateOn?: 'mount' | 'hover' | 'view';
}

const DEFAULT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*';

export function DecryptedText({
  text,
  speed = 30,
  maxIterations = 8,
  sequential = true,
  revealDirection = 'start',
  useOriginalCharsOnly = false,
  characters = DEFAULT_CHARS,
  className = '',
  parentClassName = '',
  encryptedClassName = 'decrypted-encrypted',
  animateOn = 'mount',
}: DecryptedTextProps) {
  const reduce = useReducedMotion();
  const [displayText, setDisplayText] = useState<string>(text);
  const [isAnimating, setIsAnimating] = useState<boolean>(false);
  const [revealedIndices, setRevealedIndices] = useState<Set<number>>(new Set());
  const intervalRef = useRef<number | null>(null);

  const availableChars = useMemo<string[]>(() => {
    return useOriginalCharsOnly
      ? Array.from(new Set(text.split(''))).filter((char) => char !== ' ')
      : characters.split('');
  }, [useOriginalCharsOnly, text, characters]);

  const shuffleText = useCallback(
    (originalText: string, currentRevealed: Set<number>) => {
      return originalText
        .split('')
        .map((char, i) => {
          if (char === ' ' || char === '·') return char;
          if (currentRevealed.has(i)) return originalText[i];
          return availableChars[Math.floor(Math.random() * availableChars.length)] ?? char;
        })
        .join('');
    },
    [availableChars],
  );

  const startAnimation = useCallback(() => {
    if (reduce) {
      setDisplayText(text);
      setIsAnimating(false);
      setRevealedIndices(new Set(Array.from({ length: text.length }, (_, i) => i)));
      return;
    }

    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    const len = text.length;
    let iteration = 0;
    const revealed = new Set<number>();
    // Simbol statis dan spasi langsung terbuka agar layout stabil.
    for (let i = 0; i < len; i++) {
      if (text[i] === ' ' || text[i] === '·') revealed.add(i);
    }
    setRevealedIndices(new Set(revealed));
    setDisplayText(shuffleText(text, revealed));
    setIsAnimating(true);

    const getNextIndices = (currentRevealed: Set<number>): number[] => {
      const candidates: number[] = [];
      for (let i = 0; i < len; i++) {
        if (!currentRevealed.has(i)) candidates.push(i);
      }
      if (candidates.length === 0) return [];
      if (revealDirection === 'start') {
        return [candidates[0]!];
      }
      if (revealDirection === 'end') {
        return [candidates[candidates.length - 1]!];
      }
      // center
      const mid = Math.floor(len / 2);
      candidates.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
      return [candidates[0]!];
    };

    intervalRef.current = window.setInterval(() => {
      iteration++;

      if (sequential) {
        if (revealed.size < len) {
          const next = getNextIndices(revealed);
          for (const idx of next) revealed.add(idx);
          setRevealedIndices(new Set(revealed));
          setDisplayText(shuffleText(text, revealed));
        } else {
          if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
          intervalRef.current = null;
          setDisplayText(text);
          setIsAnimating(false);
        }
      } else {
        if (iteration < maxIterations) {
          setDisplayText(shuffleText(text, revealed));
        } else {
          if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
          intervalRef.current = null;
          setDisplayText(text);
          setRevealedIndices(new Set(Array.from({ length: len }, (_, i) => i)));
          setIsAnimating(false);
        }
      }
    }, speed);
  }, [text, reduce, sequential, revealDirection, maxIterations, speed, shuffleText]);

  useEffect(() => {
    if (animateOn === 'mount') {
      startAnimation();
    } else {
      setDisplayText(text);
      setIsAnimating(false);
    }
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [text, animateOn, startAnimation]);

  if (reduce) {
    return <span className={className || parentClassName}>{text}</span>;
  }

  return (
    <span className={`decrypted-text-root ${parentClassName}`.trim()}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" style={{ display: 'inline-flex', whiteSpace: 'pre' }}>
        {displayText.split('').map((char, index) => {
          const isRevealed = revealedIndices.has(index) || !isAnimating;
          return (
            <span
              key={index}
              className={isRevealed ? className : encryptedClassName}
              style={{ display: 'inline-block' }}
            >
              {char}
            </span>
          );
        })}
      </span>
    </span>
  );
}
