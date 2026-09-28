import {
  IconPlayerPlay,
  IconTicket,
  IconDeviceTv,
  IconMovie,
  IconSearch,
  IconSubtitles,
  IconList,
  IconDownload,
  IconSettings,
  IconChartBar,
  IconUsers,
  IconExternalLink,
  type IconProps,
} from "@tabler/icons-react";
import type { IconName } from "../../shared/types";
const icons = {
  play: IconPlayerPlay,
  tickets: IconTicket,
  tv: IconDeviceTv,
  film: IconMovie,
  search: IconSearch,
  subtitles: IconSubtitles,
  list: IconList,
  download: IconDownload,
  settings: IconSettings,
  chart: IconChartBar,
  users: IconUsers,
  link: IconExternalLink,
};
export function AppIcon({ name, ...props }: IconProps & { name: IconName }) {
  const Component = icons[name];
  return <Component stroke={1.65} aria-hidden="true" {...props} />;
}
