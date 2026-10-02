export type { EmptyInput, Endpoint } from "./endpoint.js";
export type {
  ApiSchemaFromRouteDescriptors,
  RouteDefinition,
  RouteInput,
  RouteOutput,
} from "./route-descriptor.js";
export {
  binaryResponse,
  defineRoute,
  formRequest,
  jsonRequest,
  jsonResponse,
  noRequest,
  optionalQueryRequest,
  queryRequest,
} from "./route-descriptor.js";
export { typedRoutes } from "./typed-routes.js";
