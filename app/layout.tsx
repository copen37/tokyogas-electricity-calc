export const metadata = {
  title: "Tokyo Gas Electricity Calc",
  description: "Browser-only calculator for Tokyo Gas electricity plans"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body style={{ fontFamily: "sans-serif", margin: 24 }}>{children}</body>
    </html>
  );
}
