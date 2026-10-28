import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ShopPilot — your shopping assistant",
  description:
    "Tell ShopPilot what you want and your budget. It searches, compares, and builds a within-budget bill with links to buy on the retailer's site.",
};

// Applies the `.dark` class before paint based on OS preference, avoiding a
// flash of the wrong theme. The real theme switcher arrives in Phase 5.
const themeInit = `(function(){try{var m=window.matchMedia('(prefers-color-scheme: dark)');if(m.matches){document.documentElement.classList.add('dark');}m.addEventListener('change',function(e){document.documentElement.classList.toggle('dark',e.matches);});}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
