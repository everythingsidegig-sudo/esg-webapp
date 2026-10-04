import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#047857", color: "white", fontSize: 220, fontWeight: 800, letterSpacing: -8 }}>
      ESG
    </div>,
    size,
  );
}
