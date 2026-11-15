import type { Metadata } from "next";
import { HistoryGallery } from "@/components/HistoryGallery";

export const metadata: Metadata = { title: "历史画廊 · Viggle Studio" };

export default function Page() {
  return <HistoryGallery />;
}
