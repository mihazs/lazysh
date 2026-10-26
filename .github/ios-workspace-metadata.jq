# Only filesystem metadata; never retain arbitrary PBX settings or plist fields.
def bounded:
  if type == "string" then
    if length > 128 then .[0:125] + "..." else . end
  elif type == "number" then .
  elif type == "array" then
    if length > 8 then .[:7] | map(select(type == "string") | bounded) + ["[truncated]"]
    else map(select(type == "string") | bounded) end
  else null end;
def settings:
  if type != "object" then error("unknown settings schema") else
    with_entries(select(.key | IN("SDKROOT", "IPHONEOS_DEPLOYMENT_TARGET",
      "SUPPORTED_PLATFORMS", "SUPPORTED_DESTINATIONS", "ARCHS", "VALID_ARCHS",
      "EXCLUDED_ARCHS", "TEST_HOST", "TEST_TARGET_NAME", "BUNDLE_LOADER")))
    | map_values(bounded)
  end;
def configs($objects; $list):
  $objects[$list] as $configList
  | if $configList.isa != "XCConfigurationList" or ($configList.buildConfigurations | type) != "array"
    then error("unknown configuration list") else
    {truncated: ($configList.buildConfigurations | length > 32),
      values: [$configList.buildConfigurations[:32][] | $objects[.] as $config
        | if $config.isa != "XCBuildConfiguration" then error("unknown configuration") else
          {configuration: (if ($config.name | IN("debug", "release", "Debug", "Release"))
            then $config.name else "unknown" end), settings: ($config.buildSettings | settings)}
        end]}
  end;
if $kind == "project" then
  .objects as $objects | $objects[.rootObject] as $project
  | if ($objects | type) != "object" or $project.isa != "PBXProject" or ($project.targets | type) != "array"
    then error("unknown project schema") else
    [$project.targets[] | $objects[.] | select(.isa == "PBXNativeTarget" and .name == "LazyshWorkspaceUITests")] as $targets
    | if ($targets | length) != 1 then error("missing or ambiguous workspace target") else
      {project: configs($objects; $project.buildConfigurationList),
       workspaceTarget: {productType: ($targets[0].productType | bounded),
         configurations: configs($objects; $targets[0].buildConfigurationList)}}
    end
  end
elif $kind == "device" then
  if type != "object" or .UDID != $device or (.runtime | type) != "string" or (.deviceType | type) != "string"
    or (.state | type) != "number" or (.state | floor) != .state or .state < 0 or .state > 10
  then error("unknown persisted device schema") else
    {UDID, runtime: (.runtime | bounded), deviceType: (.deviceType | bounded), persistedState: .state,
      availability: "unknown (filesystem metadata only)"}
  end
else error("unknown metadata kind") end
