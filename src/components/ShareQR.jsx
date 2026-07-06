import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// QR code for a share URL, for scanning with a phone. The tile keeps a fixed
// white background in both themes — a QR needs a light quiet zone to scan, the
// same fixed-color rule as terminal panels.
export default function ShareQR({ url, size = 116 }) {
  const [dataUrl, setDataUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!url) {
      setDataUrl(null);
      return undefined;
    }
    QRCode.toDataURL(url, { margin: 1, width: size * 2 })
      .then((d) => {
        if (!cancelled) setDataUrl(d);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url, size]);

  if (!dataUrl) return null;

  return (
    <div
      className="inline-flex bg-white rounded-xl p-2 border border-gray-100"
      title="Scan to open on your phone"
    >
      <img src={dataUrl} alt={`QR code for ${url}`} width={size} height={size} />
    </div>
  );
}
