/**
 * The props `<ParamField>` and `<ResponseField>` take, in Mintlify's shape: a
 * parameter names its location with the attribute that carries its name
 * (`<ParamField query="limit">`), and both take `type`, `required`,
 * `deprecated`, and `default`; a response field adds `pre` and `post` labels
 * around its name. Pure, so the Markdown downlevel and the playground can
 * read fields the way the components render them.
 */

/** Where a `<ParamField>` parameter goes, in the order the attributes are checked. */
export const PARAM_LOCATIONS = ["path", "query", "header", "body"] as const;

/** A parameter's location. */
export type ParamLocation = (typeof PARAM_LOCATIONS)[number];

/** A literal value as MDX passes it: a string attribute, or an expression's data. */
export type FieldValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FieldValue[]
  | { [key: string]: FieldValue };

/** A boolean prop: MDX shorthand (`required`) is `true`, `required="true"` a string. */
export type FlagProp = boolean | string;

/** What both field components take. */
export interface FieldProps {
  /** The value used when none is given. */
  default?: FieldValue;
  deprecated?: FlagProp;
  required?: FlagProp;
  /** Free text: `string`, `integer`, `string[]`, `object`. */
  type?: string;
}

/** `<ParamField>`: a request parameter, named by its location attribute. */
export interface ParamFieldProps extends FieldProps {
  body?: string;
  header?: string;
  /** The name, for a field with no location attribute. */
  name?: string;
  path?: string;
  /**
   * An example value: the one the playground and request samples start
   * with, not an input's placeholder hint (see `fieldSchema`).
   */
  placeholder?: string;
  query?: string;
}

/** `<ResponseField>`: a field of the response. */
export interface ResponseFieldProps extends FieldProps {
  name: string;
  /** Labels after the name. */
  post?: string | string[];
  /** Labels before the name. */
  pre?: string | string[];
}

/** Whether a flag prop is on. */
export const isOn = (value?: FlagProp): boolean =>
  value === true || value === "true";

/** Where a parameter goes, and what it's called. */
export interface ParamFieldName {
  location?: ParamLocation;
  name?: string;
}

/** A parameter's location and name: the first location attribute set, else `name`. */
export const paramField = (props: ParamFieldProps): ParamFieldName => {
  for (const location of PARAM_LOCATIONS) {
    const name = props[location];
    if (name !== undefined) {
      return { location, name };
    }
  }
  return { name: props.name };
};

const isText = (value: FieldValue): value is string =>
  typeof value === "string";

/** A default value as shown: text as written, anything else as JSON; `null` when there is none. */
export const defaultLabel = (value?: FieldValue): string | null => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return isText(value) ? value : JSON.stringify(value);
};

/** `pre`/`post` labels as a list, whether one was written or several. */
export const fieldLabels = (value?: string | string[]): string[] => {
  if (value === undefined) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).filter(
    (label) => label !== ""
  );
};
