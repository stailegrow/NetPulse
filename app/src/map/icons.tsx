import type { ReactNode } from "react";

/**
 * Иконки узлов карты сети: у каждого типа три варианта в едином линейном стиле
 * (сетка 24×24, линия 1.7, скруглённые концы). Цвет задаётся через currentColor —
 * его определяет состояние узла.
 */
export type NodeType =
  | "router" | "switch" | "firewall" | "wifi" | "server" | "hypervisor" | "storage"
  | "vpn" | "cloud" | "site" | "dns" | "pc" | "phone" | "camera" | "printer"
  | "ups" | "pos" | "building" | "device" | "hop";

export const NODE_TYPES: { k: NodeType; l: string }[] = [
  { k: "router", l: "Маршрутизатор" },
  { k: "switch", l: "Коммутатор" },
  { k: "firewall", l: "Межсетевой экран" },
  { k: "wifi", l: "Точка доступа Wi-Fi" },
  { k: "server", l: "Сервер" },
  { k: "hypervisor", l: "Гипервизор" },
  { k: "storage", l: "Хранилище" },
  { k: "vpn", l: "VPN / туннель" },
  { k: "cloud", l: "Интернет / облако" },
  { k: "site", l: "Сайт / сервис" },
  { k: "dns", l: "DNS-сервер" },
  { k: "pc", l: "Компьютер" },
  { k: "phone", l: "Телефония" },
  { k: "camera", l: "Камера" },
  { k: "printer", l: "Принтер / МФУ" },
  { k: "ups", l: "ИБП" },
  { k: "pos", l: "Касса / терминал" },
  { k: "building", l: "Офис / магазин" },
  { k: "device", l: "Устройство" },
  { k: "hop", l: "Промежуточный узел" },
];

const dot = (x: number, y: number, r = 0.9) => <circle cx={x} cy={y} r={r} fill="currentColor" stroke="none" />;

const ICONS: Record<NodeType, [ReactNode, ReactNode, ReactNode]> = {
  router: [
    <>
      <ellipse cx="12" cy="9" rx="8" ry="3.4" />
      <path d="M4 9v5.5c0 1.9 3.6 3.4 8 3.4s8-1.5 8-3.4V9" />
      <path d="M9.2 9h5.6M12 7.4v3.2" />
    </>,
    <>
      <rect x="3" y="11" width="18" height="7.5" rx="2" />
      <path d="M7 11V5.5M17 11V5.5M14 14.7h3.5" />
      {dot(7, 14.7)}
      {dot(10, 14.7)}
    </>,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v9M9.8 9.6 12 7.5l2.2 2.1M9.8 14.4 12 16.5l2.2-2.1M7.5 12h9M9.6 9.8 7.5 12l2.1 2.2M14.4 9.8 16.5 12l-2.1 2.2" />
    </>,
  ],
  switch: [
    <>
      <rect x="2.5" y="8" width="19" height="8" rx="2" />
      <path d="M6 13.2v-2.4M9 13.2v-2.4M12 13.2v-2.4M15 13.2v-2.4M18 13.2v-2.4" />
    </>,
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M7 10.2h9.5l-2-2M17 13.8H7.5l2 2" />
    </>,
    <>
      <rect x="3" y="4.5" width="18" height="6.5" rx="1.5" />
      <rect x="3" y="13" width="18" height="6.5" rx="1.5" />
      <path d="M6.5 7.75h5M6.5 16.25h5" />
      {dot(17, 7.75)}
      {dot(17, 16.25)}
    </>,
  ],
  firewall: [
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="M3 9.7h18M3 14.3h18M9 5v4.7M15 5v4.7M6 9.7v4.6M12 9.7v4.6M18 9.7v4.6M9 14.3V19M15 14.3V19" />
    </>,
    <>
      <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z" />
      <path d="M9 12l2 2 4-4" />
    </>,
    <>
      <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z" />
      <path d="M12 8.2c1.7 1.6 2.8 3 2.8 4.8a2.8 2.8 0 0 1-5.6 0c0-1.1.5-1.9 1.2-2.7.2.9.7 1.4 1.3 1.6-.3-1.3-.1-2.5.3-3.7z" />
    </>,
  ],
  wifi: [
    <>
      <ellipse cx="12" cy="17.5" rx="7.5" ry="2.7" />
      <path d="M8.7 11.6a4.8 4.8 0 0 1 6.6 0M6.2 9a8.4 8.4 0 0 1 11.6 0" />
      {dot(12, 14.3, 1.1)}
    </>,
    <>
      <path d="M12 11v10M8.5 21h7" />
      <circle cx="12" cy="9" r="1.4" />
      <path d="M8.8 5.8a4.5 4.5 0 0 0 0 6.4M15.2 5.8a4.5 4.5 0 0 1 0 6.4M6.3 3.3a8 8 0 0 0 0 11.4M17.7 3.3a8 8 0 0 1 0 11.4" />
    </>,
    <>
      <path d="M2.5 9a13.5 13.5 0 0 1 19 0M5.5 12.2a9 9 0 0 1 13 0M8.6 15.4a4.6 4.6 0 0 1 6.8 0" />
      {dot(12, 18.8, 1.3)}
    </>,
  ],
  server: [
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M11 7.5h6M11 16.5h6" />
      {dot(7, 7.5)}
      {dot(7, 16.5)}
    </>,
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2" />
      <path d="M9.5 6.5h5M9.5 9.5h5" />
      <circle cx="12" cy="16" r="1.7" />
    </>,
    <>
      <rect x="3" y="3.5" width="18" height="5" rx="1.2" />
      <rect x="3" y="9.5" width="18" height="5" rx="1.2" />
      <rect x="3" y="15.5" width="18" height="5" rx="1.2" />
      <path d="M10 6h7M10 12h7M10 18h7" />
      {dot(6.5, 6)}
      {dot(6.5, 12)}
      {dot(6.5, 18)}
    </>,
  ],
  hypervisor: [
    <>
      <path d="M12 3l9 4.5-9 4.5-9-4.5z" />
      <path d="M3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5" />
    </>,
    <>
      <path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z" />
      <path d="M4 7.4l8 4.6 8-4.6M12 12v9.2" />
    </>,
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <rect x="6.5" y="6.5" width="4.5" height="4.5" rx="1" />
      <rect x="13" y="6.5" width="4.5" height="4.5" rx="1" />
      <rect x="6.5" y="13" width="4.5" height="4.5" rx="1" />
      <rect x="13" y="13" width="4.5" height="4.5" rx="1" />
    </>,
  ],
  storage: [
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </>,
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 7h8M8 10.5h8M8 14h8" />
      {dot(16, 17.8)}
    </>,
    <>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="M3 13h18" />
      {dot(16.5, 15)}
      {dot(13.5, 15)}
    </>,
  ],
  vpn: [
    <>
      <rect x="5.5" y="10.5" width="13" height="10" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      {dot(12, 15.5, 1.3)}
    </>,
    <>
      <path d="M3 19v-8a9 9 0 0 1 18 0v8M7.5 19v-7.5a4.5 4.5 0 0 1 9 0V19M2 19h20" />
    </>,
    <>
      <circle cx="7.5" cy="15.5" r="3.8" />
      <path d="M10.2 12.8 20 3M16.5 6.5l2.5 2.5M14 9l2 2" />
    </>,
  ],
  cloud: [
    <>
      <path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.3 9.3 4.6 4.6 0 0 0 7 18.5z" />
    </>,
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z" />
    </>,
    <>
      <path d="M7.5 13.5h9a3.5 3.5 0 0 0 .5-6.96A4.8 4.8 0 0 0 7.8 5.5a4 4 0 0 0-.3 8z" />
      <path d="M12 13.5V17M7 17h10M7 17v1.8M17 17v1.8M12 17v1.8" />
      {dot(7, 20.2, 1.3)}
      {dot(12, 20.2, 1.3)}
      {dot(17, 20.2, 1.3)}
    </>,
  ],
  site: [
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M3 8.5h18M7 12.5h6M7 15.5h10" />
      {dot(5.7, 6.5, 0.7)}
      {dot(7.9, 6.5, 0.7)}
    </>,
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M9.5 10 7 12.5 9.5 15M14.5 10l2.5 2.5-2.5 2.5" />
    </>,
    <>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </>,
  ],
  dns: [
    <>
      <path d="M12 3v18M8.5 21h7M12 5.5h6.5l2 2-2 2H12zM12 11.5H5.5l-2 2 2 2H12z" />
    </>,
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 3v18M12 8h4M12 11.5h4" />
    </>,
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M3.5 9h11M9 3.5c1.5 1.5 2.2 3.3 2.2 5.5s-.7 4-2.2 5.5" />
      <rect x="12.5" y="14" width="8.5" height="6.5" rx="1.2" />
      <path d="M15 17.2h3.5" />
    </>,
  ],
  pc: [
    <>
      <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </>,
    <>
      <rect x="5" y="5" width="14" height="10" rx="1.5" />
      <path d="M3 19h18l-2-4H5z" />
    </>,
    <>
      <rect x="2.5" y="5" width="12" height="9" rx="1.5" />
      <path d="M6 18h5M8.5 14v4M18 8.5h2" />
      <rect x="16.5" y="5" width="5" height="14" rx="1.2" />
    </>,
  ],
  phone: [
    <>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M6 8V6.5A2.5 2.5 0 0 1 8.5 4h7A2.5 2.5 0 0 1 18 6.5V8" />
      {dot(8, 12.5)}
      {dot(12, 12.5)}
      {dot(16, 12.5)}
      {dot(8, 16)}
      {dot(12, 16)}
      {dot(16, 16)}
    </>,
    <>
      <path d="M5 4h3.5l1.8 4.5-2.3 1.5a11 11 0 0 0 6 6l1.5-2.3 4.5 1.8V19a1.5 1.5 0 0 1-1.5 1.5A16.5 16.5 0 0 1 3.5 5.5 1.5 1.5 0 0 1 5 4z" />
    </>,
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2M19 19.5v.3a2.5 2.5 0 0 1-2.5 2.5H13" />
      <rect x="3" y="13.5" width="4" height="6" rx="1.5" />
      <rect x="17" y="13.5" width="4" height="6" rx="1.5" />
    </>,
  ],
  camera: [
    <>
      <path d="M3.5 8l12-3.5 2 6.5-12 3.5zM17.5 10.5l3-1-1-3.3-3 1M8 13.2 9 18.5H5.5" />
    </>,
    <>
      <path d="M4 10h16M5.5 10a6.5 6.5 0 0 0 13 0" />
      <rect x="7" y="5.5" width="10" height="4.5" rx="1" />
      <circle cx="12" cy="12.8" r="2" />
    </>,
    <>
      <rect x="2.5" y="6.5" width="13" height="11" rx="2" />
      <path d="M15.5 10.5l6-3.5v10l-6-3.5z" />
    </>,
  ],
  printer: [
    <>
      <path d="M7 9V3.5h10V9" />
      <rect x="3" y="9" width="18" height="8" rx="2" />
      <rect x="7" y="14" width="10" height="6.5" rx=".5" />
      {dot(17.5, 12)}
    </>,
    <>
      <rect x="3" y="7" width="18" height="11" rx="2" />
      <path d="M3 10.5h18M7 18v2.5h10V18M15 14h3" />
    </>,
    <>
      <rect x="4" y="9.5" width="16" height="8.5" rx="2" />
      <path d="M8 9.5v-5h8v5M8 18v1.5h8V18M7.5 13h3" />
    </>,
  ],
  ups: [
    <>
      <rect x="3" y="7" width="16" height="10" rx="2" />
      <path d="M21 10.5v3M11.5 9 9 12.5h4L10.5 15" />
    </>,
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2" />
      <path d="M12.8 7 9.8 12h4.5l-3 5" />
    </>,
    <>
      <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />
    </>,
  ],
  pos: [
    <>
      <rect x="3.5" y="11" width="17" height="9" rx="1.5" />
      <rect x="6" y="4" width="8" height="5" rx="1" />
      <path d="M10 9v2M3.5 16.5h17" />
      {dot(7, 13.6)}
      {dot(10, 13.6)}
      {dot(13, 13.6)}
    </>,
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2" />
      <rect x="8.5" y="5" width="7" height="5" rx=".8" />
      {dot(9.5, 13.5)}
      {dot(12, 13.5)}
      {dot(14.5, 13.5)}
      {dot(9.5, 16.5)}
      {dot(12, 16.5)}
      {dot(14.5, 16.5)}
    </>,
    <>
      <path d="M6 2.5h12v19l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4zM9 7.5h6M9 11h6M9 14.5h4" />
    </>,
  ],
  building: [
    <>
      <path d="M3.5 9.5 5 4h14l1.5 5.5" />
      <path d="M3.5 9.5a2.1 2.1 0 0 0 4.2 0 2.1 2.1 0 0 0 4.3 0 2.1 2.1 0 0 0 4.3 0 2.1 2.1 0 0 0 4.2 0" />
      <path d="M5 12v8.5h14V12M10 20.5v-5h4v5" />
    </>,
    <>
      <rect x="5" y="3" width="14" height="18" rx="1" />
      <path d="M11 21v-3.5h2V21" />
      {dot(9, 7)}
      {dot(12, 7)}
      {dot(15, 7)}
      {dot(9, 11)}
      {dot(12, 11)}
      {dot(15, 11)}
      {dot(9, 15)}
      {dot(15, 15)}
    </>,
    <>
      <path d="M3.5 11 12 4l8.5 7M6 9.5V20h12V9.5M10 20v-5h4v5" />
    </>,
  ],
  device: [
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3" />
    </>,
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <circle cx="12" cy="12" r="3" />
    </>,
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="12" cy="20" r="2" />
      <path d="M10 10.5 6.5 7.3M14 10.5l3.5-3.2M12 15v3" />
    </>,
  ],
  hop: [
    <>
      <circle cx="12" cy="12" r="6" />
      {dot(12, 12, 2)}
    </>,
    <>
      <path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z" />
      {dot(12, 12, 2)}
    </>,
    <>
      <path d="M12 4l8 8-8 8-8-8zM9 12h6" />
    </>,
  ],
};

export function NodeIcon({ type, variant = 0, size = 24 }: { type: NodeType; variant?: number; size?: number }) {
  const set = ICONS[type] ?? ICONS.device;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {set[variant % 3]}
    </svg>
  );
}

/** Та же иконка, но как фрагмент внутри общего SVG карты (без вложенного <svg>). */
export function NodeGlyph({ type, variant = 0, size = 24, x = 0, y = 0 }: { type: NodeType; variant?: number; size?: number; x?: number; y?: number }) {
  const set = ICONS[type] ?? ICONS.device;
  const k = size / 24;
  return (
    <g transform={`translate(${x - size / 2},${y - size / 2}) scale(${k})`} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {set[variant % 3]}
    </g>
  );
}

/**
 * Тип узла по умолчанию — по виду проверки, имени и группе. Правила идут от
 * частного к общему: первое совпадение выигрывает, пользователь может поменять.
 */
export function guessType(kind: string, name: string, group: string, host: string): NodeType {
  if (kind === "http") return "site";
  if (kind === "dns") return "dns";
  const s = ` ${name} ${group} ${host} `.toLowerCase();
  const rules: [RegExp, NodeType][] = [
    [/касс|kassa|atol|эвотор|evotor|\bpos\b|терминал/, "pos"],
    [/wi-?fi|wlan|\bap\d|[-_ ]ap\d|\bap\b|точк[аи] доступа|ssid/, "wifi"],
    [/firewall|\bfw\d*\b|[-_]fw|forti|ngfw|usergate|ideco|pfsense|opnsense|\basa\b|checkpoint|межсет/, "firewall"],
    [/switch|\bsw\d|[-_]sw\d|[-_]sw\b|коммутат/, "switch"],
    [/esxi|vcenter|vmware|proxmox|hyper-?v|\bhv\d|[-_]hv\d|гипервиз/, "hypervisor"],
    [/\bnas\b|storage|\bsan\b|backup|synology|qnap|схд|хранилищ|[-_]stor/, "storage"],
    [/camera|\bcam\d*\b|cctv|\bnvr\b|\bdvr\b|trassir|hikvision|dahua|камер|видеонаб/, "camera"],
    [/\bups\b|eaton|\bapc\b|ибп|[-_]ups/, "ups"],
    [/voip|\bsip\b|\bpbx\b|asterisk|voice|телефон|\bатс\b/, "phone"],
    [/print|\bprn\b|\bmfu\b|мфу|принтер/, "printer"],
    [/\bgre\b|gre[-_ ]|vpn|ipsec|tunnel|туннел|wireguard|openvpn|l2tp/, "vpn"],
    [/router|rtr\d|\brtr\b|[-_]rtr|gateway|\bgw\d*\b|[-_]gw|маршрутиз|\bedge\b|\bisp\d*\b|[-_]isp/, "router"],
    [/server|\bsrv\d*|[-_]srv|сервер|\bdc\d|\bsql|\bdb\d*\b|\b1c\b|\brdp\b|mail|exchange/, "server"],
    [/\bpc\d*\b|[-_]pc|компьютер|workstation|\bарм\b|desktop|laptop|ноутбук/, "pc"],
    [/магазин|\bshop\b|store|офис|office|филиал|branch/, "building"],
    [/cloud|облак|\bdns\b|\bweb\b|сайт|site|\.ru\b|\.com\b/, "cloud"],
    [/\bl2\b|link|канал|core|ядро/, "switch"],
  ];
  for (const [re, type] of rules) if (re.test(s)) return type;
  return kind === "tcp" ? "server" : "device";
}
