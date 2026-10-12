import { Config } from '@remotion/cli/config';

/* Authoring-only configuration for the bundled onboarding walkthroughs. */
Config.overrideWebpackConfig((configuration) => ({
  ...configuration,
  resolve: {
    ...configuration.resolve,
    extensionAlias: { ...configuration.resolve?.extensionAlias, '.js': ['.js', '.ts', '.tsx'] },
  },
}));
