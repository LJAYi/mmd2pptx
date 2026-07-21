export const EXAMPLE_DIAGRAM = `flowchart LR
    REQUEST["Feature request<br/>goal · audience"]
    PLAN["Implementation plan<br/>scope · milestones"]
    DESIGN["Interface design<br/>states · accessibility"]
    BUILD["Build feature<br/>code · tests"]
    DOCS["Write documentation<br/>guide · examples"]
    REVIEW["Peer review<br/>quality · security"]
    QA["Release checks<br/>browsers · downloads"]
    RELEASE["Publish release<br/>version · notes"]
    FEEDBACK["Collect feedback<br/>issues · ideas"]

    REQUEST --> PLAN --> DESIGN
    DESIGN --> BUILD & DOCS
    BUILD & DOCS --> REVIEW
    REVIEW --> QA --> RELEASE --> FEEDBACK
    FEEDBACK -.-> PLAN

    classDef source fill:#eef4f7,stroke:#24323d,stroke-width:1.5px
    classDef process fill:#faf0e6,stroke:#24323d,stroke-width:1.7px
    classDef output fill:#f6ece6,stroke:#24323d,stroke-width:2.2px
    class REQUEST,PLAN,DESIGN source
    class BUILD,DOCS,REVIEW,QA process
    class RELEASE,FEEDBACK output`;

export const MINI_EXAMPLE = `flowchart LR
    Idea([Idea]) --> Draft[Draft]
    Draft --> Review{Approved?}
    Review -- Yes --> Ship([Ship])
    Review -- No --> Draft`;
