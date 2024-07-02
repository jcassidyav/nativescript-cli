import { glob } from "glob";
import { homedir } from "os";
import * as path from "path";
import { PromptObject } from "prompts";
import { color } from "../color";
import {
	IChildProcess,
	IFileSystem,
	IFsStats,
	IHostInfo,
} from "../common/declarations";
import { ICommand, ICommandParameter } from "../common/definitions/commands";
import { injector } from "../common/yok";
import { IOptions, IStaticConfig } from "../declarations";
import { IProjectData } from "../definitions/project";

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
		private $prompter: IPrompter
	) {}

	public async execute(args: string[]): Promise<void> {
		const platform = args[0];
		let result;
		if (this.$mobileHelper.isAndroidPlatform(platform)) {
			result = await this.handleAndroidTypings();
		} else if (this.$mobileHelper.isiOSPlatform(platform)) {
			result = await this.handleiOSTypings();
		}
		let typingsFolder = "./typings";
		if (this.$options.copyTo && result !== false) {
			this.$fs.copyFile(
				path.resolve(this.$projectData.projectDir, "typings"),
				this.$options.copyTo
			);
			typingsFolder = this.$options.copyTo;
		}

		if (result !== false) {
			this.$logger.info(
				"Typings have been generated in the following directory:",
				typingsFolder
			);
		}
	}

	public async canExecute(args: string[]): Promise<boolean> {
		const platform = args[0];
		this.$mobileHelper.validatePlatformName(platform);
		return true;
	}

	private async resolveGradleDependencies(target: string) {
		const gradleHome = path.resolve(
			process.env.GRADLE_USER_HOME ?? path.join(homedir(), `/.gradle`)
		);
		const gradleFiles = path.resolve(gradleHome, "caches/modules-2/files-2.1/");

		if (!this.$fs.exists(gradleFiles)) {
			this.$logger.warn("No gradle files found");
			return;
		}

		const pattern = `${target.replaceAll(":", "/")}/**/*.{jar,aar}`;

		const res = await glob(pattern, {
			cwd: gradleFiles,
		});

		if (!res || res.length === 0) {
			this.$logger.warn("No files found");
			return [];
		}

		const items = res.map((item) => {
			const [group, artifact, version, sha1, file] = item.split("/");
			return {
				id: sha1 + version,
				group,
				artifact,
				version,
				sha1,
				file,
				path: path.resolve(gradleFiles, item),
			};
		});

		this.$logger.clearScreen();

		const choices = await this.$prompter.promptForChoice(
			`Select dependencies to generate typings for (${color.greenBright(
				target
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
							item.artifact
						)}:${color.yellow(item.version)} - ${color.cyanBright.bold(
							item.file
						)}`,
						value: item.id,
					};
				}),
			true,
			{
				optionsPerPage: process.stdout.rows - 6, // 6 lines are taken up by the instructions
			} as Partial<PromptObject>
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
						err
					);
				}
			}
		}
		let localFilesResult = this.$options.localSource
			? await this.createJarForLocalTypings()
			: {};
		if (localFilesResult.pathToJar) {
			paths.push(localFilesResult.pathToJar);
		}
		if (
			!paths.length &&
			!localFilesResult.requiresBuild &&
			!(this.$options.jar || this.$options.aar)
		) {
			this.$logger.warn(
				[
					"No .jar or .aar file specified. Please specify at least one of the following:",
					"  - path to .jar file with --jar <jar>",
					"  - path to .aar file with --aar <aar>",
				].join("\n")
			);
			return false;
		}

		this.$fs.ensureDirectoryExists(
			path.resolve(this.$projectData.projectDir, "typings", "android")
		);

		const dtsGeneratorPath = path.resolve(
			this.$projectData.projectDir,
			"platforms",
			"android",
			"build-tools",
			"dts-generator.jar"
		);
		if (!this.$fs.exists(dtsGeneratorPath) || localFilesResult.requiresBuild) {
			this.$logger.warn("No platforms folder found, preparing project now...");
			await this.$childProcess.spawnFromEvent(
				this.$hostInfo.isWindows ? "ns.cmd" : "ns",
				[localFilesResult.requiresBuild ? "build" : "prepare", "android"],
				"exit",
				{
					stdio: "inherit",
					shell: this.$hostInfo.isWindows,
					homedir: this.$projectData.projectDir,
				}
			);
		}
		if (localFilesResult.requiresBuild) {
			localFilesResult = await this.createJarForLocalTypings(false);
			if (localFilesResult.pathToJar) paths.push(localFilesResult.pathToJar);
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
			{ stdio: "inherit" }
		);
	}
	private resolvePathToBinary(
		paths: string[],
		source: IFsStats,
		checkTimes: boolean = true
	): string[] {
		for (const checkPath of paths) {
			if (this.$fs.exists(checkPath)) {
				if (!checkTimes) {
					return [checkPath];
				}
				const compiled = this.$fs.getFsStats(checkPath);
				if (compiled.mtime.valueOf() > source.mtime.valueOf()) {
					return [checkPath];
				}
			}
		}
	}
	private copyFilesForJar(
		jarSourcePath: string,
		files: CompiledResult[],
		checkTimes: boolean = true
	): boolean {
		try {
			if (files && files.length > 0) {
				for (let i = 0; i < files.length; ++i) {
					const file = files[i];
					const source = this.$fs.getFsStats(file.source);

					file.compiled = this.resolvePathToBinary(
						file.compiled,
						source,
						checkTimes
					);
					if (file.compiled) {
						this.$fs.copyFile(
							file.compiled[0],
							path.join(jarSourcePath, file.relative)
						);
					} else {
						this.$logger.warn(
							"Up-to-date compiled file not found for:",
							file.source
						);
						return false;
					}
				}
			}
		} catch {
			return false;
		}
		return true;
	}
	private async createJarForLocalTypings(
		checkTimes: boolean = true
	): Promise<LocalFilesResult> {
		let files = this.gatherSourceFiles();
		if (files.hasEntries) {
			const pathForLocalJar = path.join(
				this.$projectData.platformsDir,
				"tmpTypings"
			);

			return await this.createLocalsJarFile(pathForLocalJar, files, checkTimes);
		} else {
			this.$logger.warn("No local source files found.");
		}
		return {};
	}
	private async createLocalsJarFile(
		jarSourcePath: string,
		candidatesForJar: CandidatesForJar,
		checkTimes: boolean = true
	): Promise<LocalFilesResult> {
		/* 
			Wipe Folder
		*/
		this.$fs.deleteDirectorySafe(jarSourcePath);
		this.$fs.createDirectory(jarSourcePath);

		let result: LocalFilesResult = {};

		if (
			this.copyFilesForJar(jarSourcePath, candidatesForJar.java, checkTimes) &&
			this.copyFilesForJar(jarSourcePath, candidatesForJar.kotlin, checkTimes)
		) {
			const pathToJar = path.join(jarSourcePath, "localTypings.jar");
			let spawnResult = await this.$childProcess.spawnFromEvent(
				"jar",
				["cf", pathToJar, "-C", jarSourcePath, "."],
				"exit",
				{ stdio: "inherit" }
			);
			if (spawnResult.exitCode != 0) {
				this.$logger.error("Unable to create jar", pathToJar);
			} else {
				result.pathToJar = pathToJar;
			}
		} else {
			result.requiresBuild = true;
		}
		return result;
	}
	private gatherSourceFiles(): CandidatesForJar {
		const result = new CandidatesForJar();
		const appResources = path.join(
			path.dirname(this.$projectData.androidManifestPath),
			"java"
		);
		if (this.$fs.exists(appResources)) {
			const compiledKotlinPath = path.join(
				this.$projectData.platformsDir,
				"android",
				"app",
				"build",
				"tmp",
				"kotlin-classes",
				"debug"
			);
			const compiledJavaPath = [
				path.join(
					this.$projectData.platformsDir,
					"android",
					"app",
					"build",
					"intermediates",
					"javac",
					"debug",
					"classes"
				),
				path.join(
					this.$projectData.platformsDir,
					"android",
					"app",
					"build",
					"intermediates",
					"javac",
					"debug",
					"compileDebugJavaWithJavac",
					"classes"
				),
			];

			this.$fs.enumerateFilesInDirectorySync(appResources, (file, stat) => {
				if (stat.isDirectory()) {
					return true;
				}

				if (file.endsWith(".kt")) {
					const relative = path.relative(appResources, file);
					const classRelative =
						relative.slice(0, relative.length - 3) + ".class";
					result.kotlin.push({
						source: file,
						compiled: [path.join(compiledKotlinPath, classRelative)],
						relative: classRelative,
					});
					return true;
				} else if (file.endsWith(".java")) {
					const relative = path.relative(appResources, file);
					const classRelative =
						relative.slice(0, relative.length - 5) + ".class";
					result.java.push({
						source: file,
						compiled: [
							path.join(compiledJavaPath[0], classRelative),
							path.join(compiledJavaPath[1], classRelative),
						],
						relative: classRelative,
					});
					return true;
				}
				return false;
			});
		}
		return result;
	}

	private async handleiOSTypings() {
		if (this.$options.filter !== undefined) {
			this.$logger.warn("--filter flag is not supported yet.");
		}

		this.$fs.ensureDirectoryExists(
			path.resolve(this.$projectData.projectDir, "typings", "ios")
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
						"ios"
					),
				},
				stdio: "inherit",
			}
		);
	}
}
interface CompiledResult {
	source: string;
	compiled: string[];
	relative: string;
}
class CandidatesForJar {
	private _java = new Array<CompiledResult>();
	private _kotlin = new Array<CompiledResult>();

	public get java() {
		return this._java;
	}

	public get kotlin() {
		return this._kotlin;
	}

	public get hasEntries() {
		return this._java.length > 0 || this._kotlin.length > 0;
	}
}
interface LocalFilesResult {
	requiresBuild?: boolean;
	pathToJar?: string;
}
injector.registerCommand("typings", TypingsCommand);
