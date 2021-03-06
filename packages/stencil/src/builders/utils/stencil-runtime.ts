import {
  CompilerSystem,
  Config,
  ConfigFlags,
  Logger,
  runTask,
  TaskCommand,
} from '@stencil/core/cli';
import { createNodeLogger, createNodeSys } from '@stencil/core/sys/node';
import { loadConfig } from '@stencil/core/compiler';
import { StencilBuildOptions } from '../build/schema';
import { BuilderContext, BuilderOutput } from '@angular-devkit/architect';
import { from, Observable, of } from 'rxjs';
import { copyFile, ProjectType } from '@nrwl/workspace';
import { catchError, map, switchMap, tap } from 'rxjs/operators';
import { StencilTestOptions } from '../test/schema';
import { StencilE2EOptions } from '../e2e/schema';
import { fileExists, writeJsonFile } from '@nrwl/workspace/src/utils/fileutils';
import { OutputTarget } from '@stencil/core/internal';
import { ensureDirExist } from './fileutils';
import { getSystemPath, join, normalize, Path } from '@angular-devkit/core';

const loadCoreCompiler = async (sys: CompilerSystem): Promise<CoreCompiler> => {
  await sys.dynamicImport(sys.getCompilerExecutingPath());

  return (globalThis as any).stencil;
};

type CoreCompiler = typeof import('@stencil/core/compiler');

function getCompilerExecutingPath() {
  return require.resolve('@stencil/core/compiler');
}

type ConfigAndPathCollection = {
  config: Config;
  distDir: Path;
  coreCompiler: CoreCompiler;
  projectRoot: Path;
  projectName: string;
  pkgJson: string;
};

function copyOrCreatePackageJson(values: ConfigAndPathCollection) {
  if (fileExists(values.pkgJson)) {
    copyFile(values.pkgJson, values.distDir);
  } else {
    const libPackageJson = {
      name: values.projectName,
      main: 'dist/index.js',
      module: 'dist/index.mjs',
      es2015: 'dist/esm/index.mjs',
      es2017: 'dist/esm/index.mjs',
      types: 'dist/types/index.d.ts',
      collection: 'dist/collection/collection-manifest.json',
      'collection:main': 'dist/collection/index.js',
      unpkg: `dist/${values.projectName}/${values.projectName}.js`,
      files: ['dist/', 'loader/'],
    };

    writeJsonFile(
      getSystemPath(join(values.distDir, `package.json`)),
      libPackageJson
    );
  }
}

function calculateOutputTargetPathVariables(
  values: ConfigAndPathCollection,
  pathVariables: string[]
) {
  return values.config.outputTargets.map((outputTarget) => {
    pathVariables.forEach((pathVar) => {
      if (
        outputTarget[pathVar] != null &&
        !(outputTarget[pathVar] as string).endsWith('src')
      ) {
        const origPath = getSystemPath(
          normalize(outputTarget[pathVar] as string)
        );
        outputTarget = Object.assign(outputTarget, {
          [pathVar]: origPath.replace(values.projectRoot, values.distDir),
        });
      }
    });

    return outputTarget;
  });
}

async function initializeStencilConfig(
  taskCommand: TaskCommand,
  options: StencilBuildOptions | StencilTestOptions,
  context: BuilderContext,
  createStencilCompilerOptions: (
    taskCommand: TaskCommand,
    options: StencilBuildOptions
  ) => ConfigFlags
) {
  const configFilePath = options.configPath;

  const flags: ConfigFlags = createStencilCompilerOptions(taskCommand, options);
  const logger: Logger = createNodeLogger({ process });
  const sys: CompilerSystem = createNodeSys({ process });
  const metadata = await context.getProjectMetadata(context.target);

  if (sys.getCompilerExecutingPath == null) {
    sys.getCompilerExecutingPath = getCompilerExecutingPath;
  }

  if (flags.ci) {
    logger.enableColors(false);
  }

  const loadConfigResults = await loadConfig({
    config: {
      flags,
    },
    configPath: getSystemPath(
      join(normalize(context.workspaceRoot), configFilePath)
    ),
    logger,
    sys,
  });
  const coreCompiler = await loadCoreCompiler(sys);

  const { workspaceRoot } = context;
  const projectName: string = context.target.project;
  const distDir: Path = normalize(`${workspaceRoot}/dist/${metadata.root}`);
  const projectRoot: Path = normalize(`${workspaceRoot}/${metadata.root}`);

  return {
    projectName: projectName,
    config: loadConfigResults.config,
    projectRoot: getSystemPath(projectRoot),
    coreCompiler: coreCompiler,
    distDir: getSystemPath(distDir),
    pkgJson: getSystemPath(join(projectRoot, `package.json`)),
  } as ConfigAndPathCollection;
}

interface ConfigAndCoreCompiler {
  config: Config;
  coreCompiler: CoreCompiler;
}

export function createStencilConfig(
  taskCommand: TaskCommand,
  options: StencilBuildOptions | StencilTestOptions,
  context: BuilderContext,
  createStencilCompilerOptions: (
    taskCommand: TaskCommand,
    options: StencilBuildOptions
  ) => ConfigFlags
): Observable<ConfigAndCoreCompiler> {
  if (!options?.configPath) {
    // remove later
    throw new Error(
      'ConfigPath not set. Please use --configPath or update your project builder in workspace.json/angular.json accordingly!'
    );
  }

  return from(
    initializeStencilConfig(
      taskCommand,
      options,
      context,
      createStencilCompilerOptions
    )
  ).pipe(
    tap((values: ConfigAndPathCollection) => {
      ensureDirExist(values.distDir);

      if (options.projectType == ProjectType.Library) {
        copyOrCreatePackageJson(values);
      }

      return values.config;
    }),
    map((values: ConfigAndPathCollection) => {
      const pathVariables = [
        'dir',
        'appDir',
        'buildDir',
        'indexHtml',
        'esmDir',
        'systemDir',
        'systemLoaderFile',
        'file',
        'esmLoaderPath',
        'collectionDir',
        'typesDir',
        'legacyLoaderFile',
        'esmEs5Dir',
        'cjsDir',
        'cjsIndexFile',
        'esmIndexFile',
        'componentDts',
      ];
      const outputTargets: OutputTarget[] = calculateOutputTargetPathVariables(
        values,
        pathVariables
      );
      const devServerConfig = Object.assign(values.config.devServer, {
        root: getSystemPath(
          normalize(
            normalize(values.config.devServer.root).replace(
              normalize(values.projectRoot),
              values.distDir
            )
          )
        ),
      });

      values.config.packageJsonFilePath = getSystemPath(
        normalize(
          normalize(values.config.packageJsonFilePath).replace(
            values.projectRoot,
            values.distDir
          )
        )
      );
      if (values.config.flags.task === 'build') {
        values.config.rootDir = getSystemPath(values.distDir);
      }

      const config = Object.assign(
        values.config,
        { outputTargets: outputTargets },
        { devServer: devServerConfig }
      );

      return {
        config: config,
        coreCompiler: values.coreCompiler,
      };
    })
  );
}

export function createStencilProcess() {
  return function (
    source: Observable<ConfigAndCoreCompiler>
  ): Observable<BuilderOutput> {
    return source.pipe(
      switchMap((values) =>
        runTask(values.coreCompiler, values.config, values.config.flags.task)
      ),
      map(() => ({ success: true })),
      catchError((err) => of({ success: false, error: err }))
    );
  };
}

export function parseRunParameters(
  runOptions: string[],
  options: StencilBuildOptions | StencilTestOptions | StencilE2EOptions
) {
  Object.keys(options).forEach((optionKey) => {
    if (typeof options[optionKey] === 'boolean' && options[optionKey]) {
      runOptions.push(`--${optionKey}`);
    }
  });

  return runOptions;
}
