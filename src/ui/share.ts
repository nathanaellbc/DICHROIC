/**
 * Menyerahkan berkas ekspor ke pengguna. Di iPhone lembar Bagikan sistem
 * (Simpan Gambar, Simpan ke File, AirDrop) lebih wajar daripada unduhan;
 * di desktop, unduhan biasa.
 */
export type Delivery = 'shared' | 'downloaded' | 'cancelled';

function prefersShareSheet(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

export async function deliverFile(file: File): Promise<Delivery> {
  if (prefersShareSheet() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      // Bagikan gagal (mis. izin): jatuh ke unduhan.
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'downloaded';
}
