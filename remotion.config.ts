import { Config } from '@remotion/cli/config';

/* Authoring-only CLI configuration. API lesson rendering supplies its own bundle config. */
Config.overrideWebpackConfig((configuration) => ({
  ...configuration,
  resolve: {
    ...configuration.resolve,
    extensionAlias: { ...configuration.resolve?.extensionAlias, '.js': ['.js', '.ts', '.tsx'] },
  },
}));
