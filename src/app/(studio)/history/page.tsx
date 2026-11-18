import type { Metadata } from "next";
import { HistoryGallery } from "@/components/HistoryGallery";

export const metadata: Metadata = { title: "创作库 · Viggle Studio" };

export default function Page() {
  return <HistoryGallery />;
}
