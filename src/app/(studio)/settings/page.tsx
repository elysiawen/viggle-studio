import type { Metadata } from "next";
import { SettingsView } from "@/components/SettingsView";

export const metadata: Metadata = { title: "设置 · Viggle Studio" };

export default function Page() {
  return <SettingsView />;
}
