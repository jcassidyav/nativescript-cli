import { glob } from "node:fs/promises";
import { homedir } from "os";
import * as path from "path";
import { PromptObject } from "prompts";
import { color } from "../color";
import { IChildProcess, IFileSystem, IHostInfo } from "../common/declarations";
import { ICommand, ICommandParameter } from "../common/definitions/commands";
import { injector } from "../common/yok";
import { IOptions, IStaticConfig } from "../declarations";
import {
	IProjectConfigService,
	IProjectData,
	IProjectDataService,
} from "../definitions/project";
import * as fastGlob from "fast-glob";
import {
	androidAppResourcesFolderName,
	iOSAppResourcesFolderName,
} from "../constants";

export class TypingsCommand implements ICommand {
	public allowedParameters: ICommandParameter[] = [];
	constructor(
		private $logger: ILogger,
		private $options: IOptions,
		private $fs: IFileSystem,
		private $projectData: IProjectData,
		private $mobileHelper: Mobile.IMobileHelper,
		private $childProcess: IChildProcess,
		private $hostInfo: IHostInfo,
		private $staticConfig: IStaticConfig,
		private $prompter: IPrompter,
		private $projectDataService: IProjectDataService,
		private $projectConfigService: IProjectConfigService,
	) {}

	public async execute(args: string[]): Promise<void> {
		const platform = args[0];
		let result;
		if (this.$mobileHelper.isAndroidPlatform(platform)) {
			result = await this.handleAndroidTypings();
		} else if (this.$mobileHelper.isiOSPlatform(platform)) {
			result = await this.handleiOSTypings();
		} else if (platform === "source") {
			this.$logger.info(
				"Generating typings from source is not supported yet. Please specify a platform.",
			);
			result = await this.handleSourceTypings();
		}
		let typingsFolder = "./typings";
		if (this.$options.copyTo && platform !== "source") {
			this.$fs.copyFile(
				path.resolve(this.$projectData.projectDir, "typings"),
				this.$options.copyTo,
			);
			typingsFolder = this.$options.copyTo;
		}

		if (result !== false) {
			this.$logger.info(
				"Typings have been generated in the following directory:",
				typingsFolder,
			);
		}
	}

	public async canExecute(args: string[]): Promise<boolean> {
		const platform = args[0];
		if ("source" === platform) {
			return true;
		}
		this.$mobileHelper.validatePlatformName(platform);
		return true;
	}

	private async resolveGradleDependencies(target: string) {
		const gradleHome = path.resolve(
			process.env.GRADLE_USER_HOME ?? path.join(homedir(), `/.gradle`),
		);
		const gradleFiles = path.resolve(gradleHome, "caches/modules-2/files-2.1/");

		if (!this.$fs.exists(gradleFiles)) {
			this.$logger.warn("No gradle files found");
			return;
		}

		const pattern = `${target.replaceAll(":", "/")}/**/*.{jar,aar}`;

		const items = [];
		for await (const item of glob(pattern, {
			cwd: gradleFiles,
		})) {
			const [group, artifact, version, sha1, file] = item.split(path.sep);
			items.push({
				id: sha1 + version,
				group,
				artifact,
				version,
				sha1,
				file,
				path: path.resolve(gradleFiles, item),
			});
		}

		if (items.length === 0) {
			this.$logger.warn("No files found");
			return [];
		}

		this.$logger.clearScreen();

		const choices = await this.$prompter.promptForChoice(
			`Select dependencies to generate typings for (${color.greenBright(
				target,
			)})`,
			items
				.sort((a, b) => {
					if (a.artifact < b.artifact) return -1;
					if (a.artifact > b.artifact) return 1;

					return a.version.localeCompare(b.version, undefined, {
						numeric: true,
						sensitivity: "base",
					});
				})
				.map((item) => {
					return {
						title: `${color.white(item.group)}:${color.greenBright(
							item.artifact,
						)}:${color.yellow(item.version)} - ${color.styleText(
							["cyanBright", "bold"],
							item.file,
						)}`,
						value: item.id,
					};
				}),
			true,
			{
				optionsPerPage: process.stdout.rows - 6, // 6 lines are taken up by the instructions
			} as Partial<PromptObject>,
		);

		this.$logger.clearScreen();

		return items
			.filter((item) => choices.includes(item.id))
			.map((item) => item.path);
	}

	private async handleAndroidTypings() {
		const targets = this.$options.argv._.slice(2) ?? [];
		const paths: string[] = [];

		if (targets.length) {
			for (const target of targets) {
				try {
					paths.push(...(await this.resolveGradleDependencies(target)));
				} catch (err) {
					this.$logger.trace(
						`Failed to resolve gradle dependencies for target "${target}"`,
						err,
					);
				}
			}
		}

		if (!paths.length && !(this.$options.jar || this.$options.aar)) {
			this.$logger.warn(
				[
					"No .jar or .aar file specified. Please specify at least one of the following:",
					"  - path to .jar file with --jar <jar>",
					"  - path to .aar file with --aar <aar>",
				].join("\n"),
			);
			return false;
		}

		this.$fs.ensureDirectoryExists(
			path.resolve(this.$projectData.projectDir, "typings", "android"),
		);

		const dtsGeneratorPath = path.resolve(
			this.$projectData.projectDir,
			"platforms",
			"android",
			"build-tools",
			"dts-generator.jar",
		);
		if (!this.$fs.exists(dtsGeneratorPath)) {
			this.$logger.warn("No platforms folder found, preparing project now...");
			await this.$childProcess.spawnFromEvent(
				this.$hostInfo.isWindows ? "ns.cmd" : "ns",
				["prepare", "android"],
				"exit",
				{ stdio: "inherit", shell: this.$hostInfo.isWindows },
			);
		}

		const asArray = (input: string | string[]) => {
			if (!input) {
				return [];
			}

			if (typeof input === "string") {
				return [input];
			}

			return input;
		};

		const inputs: string[] = [
			...asArray(this.$options.jar),
			...asArray(this.$options.aar),
			...paths,
		];

		await this.$childProcess.spawnFromEvent(
			"java",
			[
				"-jar",
				dtsGeneratorPath,
				"-input",
				...inputs,
				"-output",
				path.resolve(this.$projectData.projectDir, "typings", "android"),
			],
			"exit",
			{ stdio: "inherit" },
		);
	}

	private async handleiOSTypings() {
		if (this.$options.filter !== undefined) {
			this.$logger.warn("--filter flag is not supported yet.");
		}

		this.$fs.ensureDirectoryExists(
			path.resolve(this.$projectData.projectDir, "typings", "ios"),
		);

		await this.$childProcess.spawnFromEvent(
			"node",
			[this.$staticConfig.cliBinPath, "build", "ios"],
			"exit",
			{
				env: {
					...process.env,
					TNS_TYPESCRIPT_DECLARATIONS_PATH: path.resolve(
						this.$projectData.projectDir,
						"typings",
						"ios",
					),
				},
				stdio: "inherit",
			},
		);
	}

	private async handleSourceTypings(): Promise<boolean> {
		// collect java/kotlin/swift files
		let sourceFiles: SourceFiles;
		// supplied glob ?
		if (this.$options.filter) {
			this.$logger.info(
				`this is the path ${this.$options.filter} ${this.$options.copyTo}`,
			);
			const sourceFiles = await this.getRootGroup(this.$options.filter);
			sourceFiles.other = [];
		} else {
			path.posix;
			// default to resources and ios.NativeSource
			const appDirectoryPath =
				this.$projectData.getAppResourcesRelativeDirectoryPath();
			const iosNativeSource = `${path.posix.join(appDirectoryPath, iOSAppResourcesFolderName, "src")}/**/*`;
			const androidResources = `${path.posix.join(appDirectoryPath, androidAppResourcesFolderName, "src", "main", "java")}/**/*`;
			this.$logger.info(
				`Searching for source files in ${iosNativeSource} and ${androidResources}`,
			);
			const sourceFilesIos = await this.getRootGroup(iosNativeSource);
			const sourceFilesAndroid = await this.getRootGroup(androidResources);
			sourceFiles = new SourceFiles();
			sourceFiles.java = sourceFilesAndroid.java;
			sourceFiles.kotlin = sourceFilesAndroid.kotlin;
			sourceFiles.swift = sourceFilesIos.swift;

			// handle NativeSource in ns config file

			const nativeSource = this.$projectConfigService.getValue(
				"ios.NativeSources",
				[],
			);

			if (nativeSource?.length) {
				for (const source of nativeSource) {
					const sourceGroup = await this.getRootGroup(source.src);
					sourceFiles.swift.push(...sourceGroup.swift);
				}
			}
		}

		this.$logger.info(`this is the files ${JSON.stringify(sourceFiles)}`);
		let destinationRoot: string;

		// get where to place generated typings

		if (this.$options.copyTo) {
			const projectRoot = this.$projectData.projectDir;
			const fullPath = path.join(this.$options.copyTo, projectRoot);
			this.$fs.ensureDirectoryExists(fullPath);
			const stats = this.$fs.getFsStats(fullPath);
			if (stats.isDirectory()) {
				destinationRoot = fullPath;
			}
		}
		if (destinationRoot === undefined) {
			destinationRoot = path.resolve(
				this.$projectData.getAppDirectoryRelativePath(),
				"types",
			);
		}

		this.$logger.info(`Generating typings in ${destinationRoot}`);

		// default

		await this.processSwiftSources(sourceFiles.swift, destinationRoot);
		await this.processJavaSources(sourceFiles.java, destinationRoot);
		await this.processKotlinSources(sourceFiles.kotlin, destinationRoot);

		return false;
	}
	private async processSwiftSources(
		sources: string[],
		destinationRoot: string,
	): Promise<void> {
		if (sources?.length) {
			if (!this.$hostInfo.isDarwin) {
				this.$logger.warn(
					"Swift source processing is only supported on macOS hosts.",
				);
				return;
			}

			for (const source of sources) {
				await this.$childProcess.exec(
					`${path.join(__dirname, "../../node_modules/@nativescript/types-auto-src/platforms/Swift2TS/Swift2TS")} ${source} ${destinationRoot}${path.sep}swift`,
				);
			}
		}
	}
	private async processJavaSources(
		sources: string[],
		destinationRoot: string,
	): Promise<void> {
		if (sources?.length > 0) {
			const appDirectoryPath = this.$projectData.getAppResourcesDirectoryPath();
			const androidResources = `${path.join(appDirectoryPath, androidAppResourcesFolderName, "src", "main", "java")}`;

			for (const source of sources) {
				await this.$childProcess.exec(
					`java -jar ${path.join(__dirname, "../../node_modules/@nativescript/types-auto-src/platforms/Java2TS/java2TS.jar")} ${androidResources} ${source}  ${destinationRoot}${path.sep}java`,
				);
			}
		}
	}
	private async processKotlinSources(
		sources: string[],
		destinationRoot: string,
	): Promise<void> {
		if (sources?.length > 0) {
			const appDirectoryPath = this.$projectData.getAppResourcesDirectoryPath();
			const androidResources = `${path.join(appDirectoryPath, androidAppResourcesFolderName, "src", "main", "java")}`;

			for (const source of sources) {
				await this.$childProcess.exec(
					`java -jar ${path.join(__dirname, "../../node_modules/@nativescript/types-auto-src/platforms/Kotlin2TS/Kotlin2TS.jar")} ${androidResources} ${source}  ${destinationRoot}${path.sep}java`,
				);
			}
		}
	}

	private async getRootGroup(rootPath: string): Promise<SourceFiles> {
		const fileSources: SourceFiles = new SourceFiles();
		const projectRoot = this.$projectDataService.getProjectData().projectDir;

		if (fastGlob.isDynamicPattern(rootPath)) {
			const filePaths = await fastGlob(rootPath);
			for (const filePath of filePaths) {
				const sourceFilePath = path.normalize(path.join(projectRoot, filePath));
				fileSources[this.detectLanguage(sourceFilePath)].push(sourceFilePath);
			}
		} else {
			if (this.$fs.exists(rootPath)) {
				const stats = this.$fs.getFsStats(rootPath);
				if (stats.isDirectory() && !this.$fs.isEmptyDir(rootPath)) {
					this.$fs.readDirectory(rootPath).forEach((fileName) => {
						const sourceFilePath = path.join(projectRoot, fileName);
						fileSources[this.detectLanguage(sourceFilePath)].push(
							sourceFilePath,
						);
					});
				}
			}
		}

		return fileSources;
	}

	private detectLanguage(
		filePath: string,
	): "java" | "kotlin" | "swift" | "other" {
		const extension = filePath.split(".").pop()?.toLowerCase();

		switch (extension) {
			case "java":
				return "java";
			case "kt":
			case "kts":
				return "kotlin";
			case "swift":
				return "swift";
			default:
				return "other";
		}
	}
}

class SourceFiles {
	swift: string[] = [];
	java: string[] = [];
	kotlin: string[] = [];
	other: string[] = [];
}

injector.registerCommand("typings", TypingsCommand);
