/**
 * Just enough CSS color math to check contrast at build time: parse the color
 * syntaxes a theme config takes (hex, `rgb()`, `hsl()`, `hwb()`, `lab()`,
 * `lch()`, `oklab()`, `oklch()`, and named colors) to sRGB, then measure WCAG
 * 2 relative luminance and contrast. A color outside sRGB is clipped to it,
 * which is what a browser shows on an sRGB display. Anything else — `var()`,
 * `color-mix()`, `color()` — parses to `null`, and the caller says it couldn't
 * check it rather than guessing.
 */

/** An sRGB color: gamma-encoded channels and alpha, each 0–1. */
export interface Rgba {
  alpha: number;
  blue: number;
  green: number;
  red: number;
}

/** One parsed function argument. */
interface Component {
  /** `"%"`, an angle unit, or `""` for a bare number. */
  unit: string;
  value: number;
}

/** A color function's three channel arguments. */
type Channels = readonly [Component, Component, Component];

/** A parsed color function: its name and its channel and alpha arguments. */
interface ColorFunction {
  alpha?: Component;
  channels: Channels;
  name: string;
}

/** The CSS named colors, as hex. A `Map`, so `constructor` names nothing. */
const NAMED = new Map(
  Object.entries({
    aliceblue: "f0f8ff",
    antiquewhite: "faebd7",
    aqua: "00ffff",
    aquamarine: "7fffd4",
    azure: "f0ffff",
    beige: "f5f5dc",
    bisque: "ffe4c4",
    black: "000000",
    blanchedalmond: "ffebcd",
    blue: "0000ff",
    blueviolet: "8a2be2",
    brown: "a52a2a",
    burlywood: "deb887",
    cadetblue: "5f9ea0",
    chartreuse: "7fff00",
    chocolate: "d2691e",
    coral: "ff7f50",
    cornflowerblue: "6495ed",
    cornsilk: "fff8dc",
    crimson: "dc143c",
    cyan: "00ffff",
    darkblue: "00008b",
    darkcyan: "008b8b",
    darkgoldenrod: "b8860b",
    darkgray: "a9a9a9",
    darkgreen: "006400",
    darkgrey: "a9a9a9",
    darkkhaki: "bdb76b",
    darkmagenta: "8b008b",
    darkolivegreen: "556b2f",
    darkorange: "ff8c00",
    darkorchid: "9932cc",
    darkred: "8b0000",
    darksalmon: "e9967a",
    darkseagreen: "8fbc8f",
    darkslateblue: "483d8b",
    darkslategray: "2f4f4f",
    darkslategrey: "2f4f4f",
    darkturquoise: "00ced1",
    darkviolet: "9400d3",
    deeppink: "ff1493",
    deepskyblue: "00bfff",
    dimgray: "696969",
    dimgrey: "696969",
    dodgerblue: "1e90ff",
    firebrick: "b22222",
    floralwhite: "fffaf0",
    forestgreen: "228b22",
    fuchsia: "ff00ff",
    gainsboro: "dcdcdc",
    ghostwhite: "f8f8ff",
    gold: "ffd700",
    goldenrod: "daa520",
    gray: "808080",
    green: "008000",
    greenyellow: "adff2f",
    grey: "808080",
    honeydew: "f0fff0",
    hotpink: "ff69b4",
    indianred: "cd5c5c",
    indigo: "4b0082",
    ivory: "fffff0",
    khaki: "f0e68c",
    lavender: "e6e6fa",
    lavenderblush: "fff0f5",
    lawngreen: "7cfc00",
    lemonchiffon: "fffacd",
    lightblue: "add8e6",
    lightcoral: "f08080",
    lightcyan: "e0ffff",
    lightgoldenrodyellow: "fafad2",
    lightgray: "d3d3d3",
    lightgreen: "90ee90",
    lightgrey: "d3d3d3",
    lightpink: "ffb6c1",
    lightsalmon: "ffa07a",
    lightseagreen: "20b2aa",
    lightskyblue: "87cefa",
    lightslategray: "778899",
    lightslategrey: "778899",
    lightsteelblue: "b0c4de",
    lightyellow: "ffffe0",
    lime: "00ff00",
    limegreen: "32cd32",
    linen: "faf0e6",
    magenta: "ff00ff",
    maroon: "800000",
    mediumaquamarine: "66cdaa",
    mediumblue: "0000cd",
    mediumorchid: "ba55d3",
    mediumpurple: "9370db",
    mediumseagreen: "3cb371",
    mediumslateblue: "7b68ee",
    mediumspringgreen: "00fa9a",
    mediumturquoise: "48d1cc",
    mediumvioletred: "c71585",
    midnightblue: "191970",
    mintcream: "f5fffa",
    mistyrose: "ffe4e1",
    moccasin: "ffe4b5",
    navajowhite: "ffdead",
    navy: "000080",
    oldlace: "fdf5e6",
    olive: "808000",
    olivedrab: "6b8e23",
    orange: "ffa500",
    orangered: "ff4500",
    orchid: "da70d6",
    palegoldenrod: "eee8aa",
    palegreen: "98fb98",
    paleturquoise: "afeeee",
    palevioletred: "db7093",
    papayawhip: "ffefd5",
    peachpuff: "ffdab9",
    peru: "cd853f",
    pink: "ffc0cb",
    plum: "dda0dd",
    powderblue: "b0e0e6",
    purple: "800080",
    rebeccapurple: "663399",
    red: "ff0000",
    rosybrown: "bc8f8f",
    royalblue: "4169e1",
    saddlebrown: "8b4513",
    salmon: "fa8072",
    sandybrown: "f4a460",
    seagreen: "2e8b57",
    seashell: "fff5ee",
    sienna: "a0522d",
    silver: "c0c0c0",
    skyblue: "87ceeb",
    slateblue: "6a5acd",
    slategray: "708090",
    slategrey: "708090",
    snow: "fffafa",
    springgreen: "00ff7f",
    steelblue: "4682b4",
    tan: "d2b48c",
    teal: "008080",
    thistle: "d8bfd8",
    tomato: "ff6347",
    transparent: "00000000",
    turquoise: "40e0d0",
    violet: "ee82ee",
    wheat: "f5deb3",
    white: "ffffff",
    whitesmoke: "f5f5f5",
    yellow: "ffff00",
    yellowgreen: "9acd32",
  })
);

const HEX = /^#(?<digits>[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu;
const FUNCTION = /^(?<name>[a-z]+)\((?<args>[^()]*)\)$/iu;
const COMPONENT =
  /^(?<value>[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?<unit>%|deg|grad|rad|turn)?$/iu;

/** Turns per angle unit; a bare hue is in degrees. */
const TURNS_PER_UNIT = new Map([
  ["", 1 / 360],
  ["deg", 1 / 360],
  ["grad", 1 / 400],
  ["rad", 1 / (2 * Math.PI)],
  ["turn", 1],
]);

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

const fromHex = (digits: string): Rgba => {
  const full =
    digits.length <= 4
      ? [...digits].map((digit) => `${digit}${digit}`).join("")
      : digits;
  const channel = (index: number): number =>
    Number.parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
  return {
    alpha: full.length === 8 ? channel(3) : 1,
    blue: channel(2),
    green: channel(1),
    red: channel(0),
  };
};

const parseComponent = (token: string): Component | null => {
  if (token.toLowerCase() === "none") {
    return { unit: "", value: 0 };
  }
  const match = COMPONENT.exec(token)?.groups;
  return match?.value === undefined
    ? null
    : { unit: (match.unit ?? "").toLowerCase(), value: Number(match.value) };
};

/** Split a function's arguments: commas or spaces, with `/` before alpha. */
const parseFunction = (value: string): ColorFunction | null => {
  const match = FUNCTION.exec(value)?.groups;
  if (match?.name === undefined || match.args === undefined) {
    return null;
  }
  const [channelText = "", alphaText, extra] = match.args.split("/");
  const tokens = channelText
    .split(/[\s,]+/u)
    .filter(Boolean)
    .map(parseComponent);
  // The legacy comma syntax (`rgba(0, 0, 0, 0.5)`) puts alpha fourth.
  const legacyAlpha =
    alphaText === undefined && tokens.length === 4 ? tokens.pop() : undefined;
  const alpha =
    alphaText === undefined ? legacyAlpha : parseComponent(alphaText.trim());
  const [first, second, third, ...rest] = tokens;
  if (
    extra !== undefined ||
    alpha === null ||
    rest.length > 0 ||
    !first ||
    !second ||
    !third
  ) {
    return null;
  }
  return {
    alpha,
    channels: [first, second, third],
    name: match.name.toLowerCase(),
  };
};

/** A number, or a percentage of `full`. */
const scaled = (component: Component, full: number): number =>
  component.unit === "%" ? (component.value / 100) * full : component.value;

/** A hue in degrees (0–360), from any angle unit. */
const hueDegrees = (component: Component): number => {
  const degrees =
    component.value * (TURNS_PER_UNIT.get(component.unit) ?? 0) * 360;
  return ((degrees % 360) + 360) % 360;
};

/** An sRGB channel from its linear-light value. */
const encode = (linear: number): number =>
  clamp(
    linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055
  );

/** A linear-light value from its sRGB channel. */
const decode = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const fromLinear = (
  [red, green, blue]: readonly [number, number, number],
  alpha: number
): Rgba => ({
  alpha,
  blue: encode(blue),
  green: encode(green),
  red: encode(red),
});

const fromHsl = (hue: number, saturation: number, lightness: number) => {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (offset: number): number => {
    const k = (offset + hue / 30) % 12;
    return lightness - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)] as const;
};

const fromHwb = (hue: number, white: number, black: number) => {
  if (white + black >= 1) {
    const gray = white / (white + black);
    return [gray, gray, gray] as const;
  }
  const [red, green, blue] = fromHsl(hue, 1, 0.5);
  const scale = 1 - white - black;
  return [
    red * scale + white,
    green * scale + white,
    blue * scale + white,
  ] as const;
};

/** Linear sRGB from OKLab (Björn Ottosson's matrices). */
const fromOklab = (lightness: number, a: number, b: number) => {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ] as const;
};

/** Linear sRGB from CIE Lab (D50), through XYZ and a Bradford adaptation. */
const fromLab = (lightness: number, a: number, b: number) => {
  const epsilon = 216 / 24_389;
  const kappa = 24_389 / 27;
  const fy = (lightness + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const cube = (f: number): number =>
    f ** 3 > epsilon ? f ** 3 : (116 * f - 16) / kappa;
  const x = cube(fx) * 0.96422;
  const y = lightness > kappa * epsilon ? fy ** 3 : lightness / kappa;
  const z = cube(fz) * 0.82521;
  // D50 to D65.
  const x65 =
    0.955473421488075 * x - 0.02309845494876471 * y + 0.06325924320057072 * z;
  const y65 =
    -0.0283697093338637 * x + 1.0099953980813041 * y + 0.021041441191917323 * z;
  const z65 =
    0.012314014864481998 * x - 0.020507649298898964 * y + 1.330365926242124 * z;
  return [
    3.2409699419045226 * x65 -
      1.537383177570094 * y65 -
      0.4986107602930034 * z65,
    -0.9692436362808796 * x65 +
      1.8759675015077202 * y65 +
      0.04155505740717559 * z65,
    0.05563007969699366 * x65 -
      0.20397695888897652 * y65 +
      1.0569715142428786 * z65,
  ] as const;
};

/** Polar (lightness, chroma, hue) to rectangular (lightness, a, b). */
const rectangular = (lightness: number, chroma: number, hue: number) => {
  const radians = (hue * Math.PI) / 180;
  return [
    lightness,
    chroma * Math.cos(radians),
    chroma * Math.sin(radians),
  ] as const;
};

/** A color function's channels, converted to sRGB with `alpha`. */
type Converter = (channels: Channels, alpha: number) => Rgba;

const rgbChannel = (component: Component): number =>
  clamp(scaled(component, 255) / 255);

const rgb: Converter = ([red, green, blue], alpha) => ({
  alpha,
  blue: rgbChannel(blue),
  green: rgbChannel(green),
  red: rgbChannel(red),
});

/** A converter for a hue-and-two-percentages function (`hsl()`, `hwb()`). */
const cylindrical =
  (
    convert: (hue: number, x: number, y: number) => readonly number[]
  ): Converter =>
  ([hue, x, y], alpha) => {
    const [red = 0, green = 0, blue = 0] = convert(
      hueDegrees(hue),
      clamp(scaled(x, 100) / 100),
      clamp(scaled(y, 100) / 100)
    );
    return { alpha, blue: clamp(blue), green: clamp(green), red: clamp(red) };
  };

const hsl = cylindrical(fromHsl);

/** The color functions this module reads, by name. */
const CONVERTERS = new Map<string, Converter>([
  ["hsl", hsl],
  ["hsla", hsl],
  ["hwb", cylindrical(fromHwb)],
  [
    "lab",
    ([lightness, a, b], alpha) =>
      fromLinear(
        fromLab(scaled(lightness, 100), scaled(a, 125), scaled(b, 125)),
        alpha
      ),
  ],
  [
    "lch",
    ([lightness, chroma, hue], alpha) =>
      fromLinear(
        fromLab(
          ...rectangular(
            scaled(lightness, 100),
            scaled(chroma, 150),
            hueDegrees(hue)
          )
        ),
        alpha
      ),
  ],
  [
    "oklab",
    ([lightness, a, b], alpha) =>
      fromLinear(
        fromOklab(scaled(lightness, 1), scaled(a, 0.4), scaled(b, 0.4)),
        alpha
      ),
  ],
  [
    "oklch",
    ([lightness, chroma, hue], alpha) =>
      fromLinear(
        fromOklab(
          ...rectangular(
            scaled(lightness, 1),
            scaled(chroma, 0.4),
            hueDegrees(hue)
          )
        ),
        alpha
      ),
  ],
  ["rgb", rgb],
  ["rgba", rgb],
]);

/** Parse a CSS color to sRGB, or `null` for syntax this module doesn't read. */
export const parseColor = (value: string): Rgba | null => {
  const color = value.trim().toLowerCase();
  const hex = NAMED.get(color) ?? HEX.exec(color)?.groups?.digits;
  if (hex !== undefined) {
    return fromHex(hex);
  }
  const parsed = parseFunction(color);
  const convert = parsed && CONVERTERS.get(parsed.name);
  return parsed && convert
    ? convert(
        parsed.channels,
        parsed.alpha === undefined ? 1 : clamp(scaled(parsed.alpha, 1))
      )
    : null;
};

/** `color` painted over an opaque `backdrop`. */
export const composite = (color: Rgba, backdrop: Rgba): Rgba => {
  const mix = (top: number, bottom: number): number =>
    top * color.alpha + bottom * (1 - color.alpha);
  return {
    alpha: 1,
    blue: mix(color.blue, backdrop.blue),
    green: mix(color.green, backdrop.green),
    red: mix(color.red, backdrop.red),
  };
};

/** WCAG 2 relative luminance of an opaque color. */
export const luminance = (color: Rgba): number =>
  0.2126 * decode(color.red) +
  0.7152 * decode(color.green) +
  0.0722 * decode(color.blue);

/**
 * WCAG 2 contrast ratio of `foreground` on an opaque `background`, from 1 to
 * 21. A translucent foreground is painted over the background first.
 */
export const contrastRatio = (foreground: Rgba, background: Rgba): number => {
  const top = luminance(composite(foreground, background));
  const bottom = luminance(background);
  return (Math.max(top, bottom) + 0.05) / (Math.min(top, bottom) + 0.05);
};
