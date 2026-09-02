import "./globals.css";

export const metadata = {
  title: "Bigin Vibe Code Editor",
  description: "Vibe-coding IDE for the Bigin frontend team",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
