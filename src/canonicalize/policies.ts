import { defineCanonicalizationPolicy } from "./behavior-pipeline.js";
import { amazonProductPath } from "./behaviors/amazon-product.js";
import {
  aggressiveQueryParameterStripping,
  conservativeQueryParameterStripping
} from "./behaviors/query-parameters.js";
import { staticRedirectUnwrapping } from "./behaviors/static-redirects.js";
import {
  indexFileRemoval,
  percentEscapeNormalization
} from "./behaviors/url-normalization.js";

export const presetPolicies = Object.freeze({
  exact: defineCanonicalizationPolicy([]),
  clean: defineCanonicalizationPolicy([
    conservativeQueryParameterStripping
  ]),
  aggressive: defineCanonicalizationPolicy([
    staticRedirectUnwrapping,
    amazonProductPath,
    aggressiveQueryParameterStripping,
    indexFileRemoval,
    percentEscapeNormalization
  ])
});
