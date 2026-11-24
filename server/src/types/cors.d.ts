declare module "cors" {
  import type { RequestHandler } from "express";
  type Options = {
    origin?: string | boolean;
    credentials?: boolean;
    exposedHeaders?: string[];
  };
  export default function cors(options?: Options): RequestHandler;
}
